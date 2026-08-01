import base64
import os
import re
import shutil
import threading
import time
import uuid
from pathlib import Path
from typing import Dict, Optional
from urllib.parse import quote

import libtorrent as lt
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

ROOT = Path(os.environ.get("ENGINE_DOWNLOADS_PATH", "/downloads/engine"))
# Engine sessions only exist in memory. After a container restart their sparse
# verification files can never be reused safely, so clear them before accepting
# new probes instead of leaking gigabytes of abandoned test data.
if ROOT.exists():
    shutil.rmtree(ROOT, ignore_errors=True)
ROOT.mkdir(parents=True, exist_ok=True)
METADATA_TIMEOUT = int(os.environ.get("ENGINE_METADATA_TIMEOUT", "25"))
PIECE_TIMEOUT = int(os.environ.get("ENGINE_PIECE_TIMEOUT", "30"))
DEFAULT_TRACKERS = [
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.stealth.si:80/announce",
    "udp://tracker.torrent.eu.org:451/announce",
    "udp://exodus.desync.com:6969/announce",
    "https://tracker.opentrackr.org:443/announce",
]

app = FastAPI(title="AutoStream libtorrent engine", docs_url=None, redoc_url=None)
session = lt.session({
    "listen_interfaces": "0.0.0.0:6883",
    "enable_dht": True,
    "enable_lsd": True,
    "enable_upnp": True,
    "enable_natpmp": True,
    "alert_mask": int(lt.alert.category_t.error_notification),
    "user_agent": "AutoStream/1.2"
})
for router, port in [
    ("router.bittorrent.com", 6881),
    ("router.utorrent.com", 6881),
    ("dht.transmissionbt.com", 6881),
]:
    try:
        session.add_dht_router(router, port)
    except Exception:
        pass


class PrepareRequest(BaseModel):
    infoHash: str
    fileIdx: Optional[int] = None
    sources: list[str] = Field(default_factory=list)
    torrentData: Optional[str] = None


class ProbeRequest(PrepareRequest):
    timeoutMs: int = Field(default=9000, ge=1000, le=30000)
    minimumDownloadedKb: int = Field(default=64, ge=64, le=16384)


class EngineTorrent:
    def __init__(self, engine_id: str, info_hash: str, handle, file_index: int, file_path: Path, file_size: int, torrent_info):
        self.id = engine_id
        self.info_hash = info_hash
        self.handle = handle
        self.file_index = file_index
        self.file_path = file_path
        self.file_size = file_size
        self.torrent_info = torrent_info
        self.last_access = time.time()
        self.lock = threading.RLock()


torrents: Dict[str, EngineTorrent] = {}
selection_to_id: Dict[str, str] = {}
hash_handles: Dict[str, object] = {}
hash_info: Dict[str, object] = {}
selected_files: Dict[str, set[int]] = {}
global_lock = threading.RLock()


def magnet_uri(request: PrepareRequest) -> str:
    trackers = []
    for source in request.sources:
        if source.startswith("tracker:"):
            trackers.append(source[len("tracker:"):])
    trackers = list(dict.fromkeys(trackers + DEFAULT_TRACKERS))
    query = "".join(f"&tr={quote(tracker, safe='')}" for tracker in trackers)
    return f"magnet:?xt=urn:btih:{request.infoHash}{query}"


def video_file(name: str) -> bool:
    return bool(re.search(r"\.(mkv|mp4|avi|mov|m4v|webm|ts)$", name, re.I))


def wait_metadata(handle, timeout_seconds: Optional[float] = None):
    deadline = time.time() + (
        timeout_seconds if timeout_seconds is not None else METADATA_TIMEOUT
    )
    while time.time() < deadline:
        if handle.status().has_metadata:
            return handle.torrent_file()
        if handle.status().errc.value() != 0:
            raise RuntimeError(str(handle.status().errc.message()))
        time.sleep(0.2)
    raise TimeoutError("Torrent metadata timed out")


def select_file(info, requested_index: Optional[int]):
    storage = info.files()
    candidates = []
    for index in range(storage.num_files()):
        name = storage.file_path(index)
        if video_file(name):
            candidates.append((index, storage.file_size(index), name))
    if requested_index is not None:
        selected = next((item for item in candidates if item[0] == requested_index), None)
        if selected is None:
            raise ValueError(f"Requested video file index {requested_index} was not found")
        return selected
    if not candidates:
        raise ValueError("Torrent contains no playable video file")
    return max(candidates, key=lambda item: item[1])


@app.get("/health")
def health():
    return {"status": "online", "libtorrent": lt.version, "sessions": len(torrents)}


@app.post("/prepare")
def prepare(request: PrepareRequest):
    info_hash = request.infoHash.lower()
    if not re.fullmatch(r"[a-f0-9]{40}", info_hash):
        raise HTTPException(400, "Invalid info hash")

    requested_key = f"{info_hash}:{request.fileIdx if request.fileIdx is not None else 'auto'}"
    with global_lock:
        existing_id = selection_to_id.get(requested_key)
        if existing_id and existing_id in torrents:
            item = torrents[existing_id]
            item.last_access = time.time()
            return view(item)

        handle = hash_handles.get(info_hash)
        info = hash_info.get(info_hash)

    save_path = ROOT / info_hash
    save_path.mkdir(parents=True, exist_ok=True)
    created_handle = handle is None
    if created_handle:
        params = {
            "save_path": str(save_path),
            "storage_mode": lt.storage_mode_t.storage_mode_sparse
        }
        if request.torrentData:
            try:
                decoded = base64.b64decode(request.torrentData)
                info = lt.torrent_info(lt.bdecode(decoded))
                supplied_hash = str(info.info_hashes().v1).lower()
                if supplied_hash != info_hash:
                    raise ValueError("Torrent metadata info hash does not match request")
                supplied_trackers = [
                    source[len("tracker:"):]
                    for source in request.sources
                    if source.startswith("tracker:")
                ]
                for tracker in dict.fromkeys(supplied_trackers + DEFAULT_TRACKERS):
                    info.add_tracker(tracker)
                params["ti"] = info
            except Exception as error:
                raise HTTPException(400, f"Invalid torrent metadata: {error}")
        else:
            params["url"] = magnet_uri(request)
        handle = session.add_torrent(params)
        with global_lock:
            hash_handles[info_hash] = handle

    try:
        if info is None:
            metadata_timeout = (
                max(0.1, request.timeoutMs / 1000)
                if isinstance(request, ProbeRequest)
                else None
            )
            info = wait_metadata(handle, metadata_timeout)
        file_index, file_size, relative_path = select_file(info, request.fileIdx)
        engine_id = str(uuid.uuid4())
        item = EngineTorrent(
            engine_id,
            info_hash,
            handle,
            file_index,
            save_path / relative_path,
            file_size,
            info
        )
        with global_lock:
            hash_handles[info_hash] = handle
            hash_info[info_hash] = info
            selected_files.setdefault(info_hash, set()).add(file_index)
            priorities = [0] * info.files().num_files()
            for selected_index in selected_files[info_hash]:
                priorities[selected_index] = 7
            handle.prioritize_files(priorities)
            torrents[engine_id] = item
            selection_to_id[requested_key] = engine_id
        return view(item)
    except Exception as error:
        if created_handle:
            with global_lock:
                if hash_handles.get(info_hash) == handle:
                    hash_handles.pop(info_hash, None)
                    hash_info.pop(info_hash, None)
            session.remove_torrent(handle, lt.options_t.delete_files)
        raise HTTPException(503, str(error))


def view(item: EngineTorrent):
    status = item.handle.status()
    return {
        "id": item.id,
        "infoHash": item.info_hash,
        "fileIdx": item.file_index,
        "fileName": item.torrent_info.files().file_path(item.file_index),
        "fileSize": item.file_size,
        "peers": status.num_peers,
        "downloadRate": status.download_rate,
        "streamUrl": f"/stream/{item.id}"
    }


def ensure_range(item: EngineTorrent, start: int, end: int, timeout_seconds: Optional[float] = None):
    mapping = item.torrent_info.map_file(item.file_index, start, end - start + 1)
    piece_size = item.torrent_info.piece_length()
    first_piece = mapping.piece
    absolute_end = mapping.start + mapping.length - 1
    last_piece = min(item.torrent_info.num_pieces() - 1, first_piece + absolute_end // piece_size)

    with item.lock:
        for offset, piece in enumerate(range(first_piece, last_piece + 1)):
            item.handle.piece_priority(piece, 7)
            item.handle.set_piece_deadline(piece, offset * 250)

    deadline = time.time() + (
        timeout_seconds if timeout_seconds is not None else PIECE_TIMEOUT
    )
    while time.time() < deadline:
        if all(item.handle.have_piece(piece) for piece in range(first_piece, last_piece + 1)):
            return
        status = item.handle.status()
        if status.errc.value() != 0:
            raise RuntimeError(status.errc.message())
        time.sleep(0.1)
    raise TimeoutError("Requested torrent pieces timed out")


def probe_range_payload(
    item: EngineTorrent,
    start: int,
    end: int,
    required_bytes: int,
    timeout_seconds: float,
):
    mapping = item.torrent_info.map_file(
        item.file_index, start, end - start + 1
    )
    piece_size = item.torrent_info.piece_length()
    first_piece = mapping.piece
    absolute_end = mapping.start + mapping.length - 1
    last_piece = min(
        item.torrent_info.num_pieces() - 1,
        first_piece + absolute_end // piece_size,
    )

    # Probe only the pieces covering the beginning of the exact requested
    # video. File priority 7 would allow libtorrent to fetch arbitrary later
    # pieces too, making total payload a misleading health signal.
    priorities = [0] * item.torrent_info.files().num_files()
    priorities[item.file_index] = 1
    item.handle.prioritize_files(priorities)
    try:
        item.handle.set_sequential_download(True)
    except Exception:
        pass
    with item.lock:
        for offset, piece in enumerate(range(first_piece, last_piece + 1)):
            item.handle.piece_priority(piece, 7)
            item.handle.set_piece_deadline(piece, offset * 250)

    deadline = time.time() + timeout_seconds
    target_pieces = set(range(first_piece, last_piece + 1))
    last_payload = 0

    def requested_piece_payload():
        """Count bytes only from blocks belonging to the requested file range."""
        progress = 0
        try:
            queue = item.handle.get_download_queue()
        except Exception:
            queue = []
        for partial in queue:
            piece_index = getattr(partial, "piece_index", None)
            if piece_index is None and isinstance(partial, dict):
                piece_index = partial.get("piece_index")
            if piece_index not in target_pieces:
                continue
            if item.handle.have_piece(piece_index):
                continue
            blocks = getattr(partial, "blocks", None)
            if blocks is None and isinstance(partial, dict):
                blocks = partial.get("blocks", [])
            for block in blocks or []:
                block_progress = getattr(block, "bytes_progress", None)
                if block_progress is None and isinstance(block, dict):
                    block_progress = block.get("bytes_progress", 0)
                progress += max(0, int(block_progress or 0))

        # Completed pieces disappear from the partial download queue. Count
        # them as verified requested data instead of losing their progress.
        for piece in target_pieces:
            if item.handle.have_piece(piece):
                progress += piece_size
        return progress

    first_progress_at = None
    first_progress_bytes = 0
    grew_after_first_sample = False
    while time.time() < deadline:
        status = item.handle.status()
        if status.errc.value() != 0:
            raise RuntimeError(status.errc.message())
        last_payload = requested_piece_payload()
        fully_verified = all(
            item.handle.have_piece(piece)
            for piece in range(first_piece, last_piece + 1)
        )
        if last_payload > 0 and first_progress_at is None:
            first_progress_at = time.time()
            first_progress_bytes = last_payload
        elif last_payload >= first_progress_bytes + 16 * 1024:
            grew_after_first_sample = True

        # A completed, hash-verified piece is definitive. Partial blocks are
        # also useful proof, but only after the exact requested piece keeps
        # progressing over separate observations. One short burst followed by
        # a stall can no longer win the race.
        sustained = (
            first_progress_at is not None
            and time.time() - first_progress_at >= 0.75
            and grew_after_first_sample
        )
        if last_payload >= required_bytes and (fully_verified or sustained):
            return last_payload, fully_verified, sustained
        time.sleep(0.1)
    return last_payload, False, (
        first_progress_at is not None
        and time.time() - first_progress_at >= 0.75
        and grew_after_first_sample
    )


def proof_bytes(file_size: int, minimum_kb: int) -> int:
    proportional = max(0, int((file_size * 0.0001) + 0.999999))
    return min(
        file_size,
        4 * 1024 * 1024,
        max(64 * 1024, minimum_kb * 1024, proportional),
    )


@app.post("/probe")
def probe(request: ProbeRequest):
    started = time.time()
    engine_id = None
    try:
        # Use the same libtorrent handle for metadata discovery and the media
        # proof. This avoids the old qBittorrent -> export -> libtorrent double
        # discovery pass which consumed most of the user's startup deadline.
        prepared = prepare(request)
        engine_id = prepared["id"]
        item = torrents[engine_id]
        required = proof_bytes(item.file_size, request.minimumDownloadedKb)
        remaining = max(0.1, request.timeoutMs / 1000 - (time.time() - started))
        received, fully_verified, sustained = probe_range_payload(
            item, 0, required - 1, required, remaining
        )

        return {
            "success": bool(
                received >= required and (fully_verified or sustained)
            ),
            "bytes": received,
            "requiredBytes": required,
            "sustainedProgress": sustained,
            "fullyVerifiedPieces": fully_verified,
            "fileIdx": item.file_index,
            "fileName": item.torrent_info.files().file_path(item.file_index),
            "fileSize": item.file_size,
            "peers": item.handle.status().num_peers,
            "elapsedMs": int((time.time() - started) * 1000),
        }
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(504, str(error))
    finally:
        if engine_id and engine_id in torrents:
            try:
                remove(engine_id)
            except Exception:
                pass


@app.get("/stream/{engine_id}")
def stream(engine_id: str, range_header: Optional[str] = Header(None, alias="Range")):
    item = torrents.get(engine_id)
    if item is None:
        raise HTTPException(404, "Engine session not found")
    item.last_access = time.time()

    match = re.match(r"bytes=(\d+)-(\d*)", range_header or "")
    start = int(match.group(1)) if match else 0
    end = int(match.group(2)) if match and match.group(2) else min(item.file_size - 1, start + 1024 * 1024 - 1)
    end = min(end, item.file_size - 1)
    if start < 0 or start > end or start >= item.file_size:
        raise HTTPException(416, "Invalid byte range")

    try:
        ensure_range(item, start, end)
    except Exception as error:
        raise HTTPException(504, str(error))

    def chunks():
        remaining = end - start + 1
        with open(item.file_path, "rb") as source:
            source.seek(start)
            while remaining > 0:
                data = source.read(min(256 * 1024, remaining))
                if not data:
                    break
                remaining -= len(data)
                yield data

    headers = {
        "Accept-Ranges": "bytes",
        "Content-Range": f"bytes {start}-{end}/{item.file_size}",
        "Content-Length": str(end - start + 1),
        "Content-Disposition": "inline"
    }
    return StreamingResponse(chunks(), status_code=206, media_type="application/octet-stream", headers=headers)


@app.delete("/torrents/{engine_id}")
def remove(engine_id: str):
    with global_lock:
        item = torrents.pop(engine_id, None)
        if item is None:
            raise HTTPException(404, "Engine session not found")
        for key, value in list(selection_to_id.items()):
            if value == engine_id:
                selection_to_id.pop(key, None)

        remaining = [value for value in torrents.values() if value.info_hash == item.info_hash]
        if remaining:
            active_indexes = {value.file_index for value in remaining}
            selected_files[item.info_hash] = active_indexes
            priorities = [0] * item.torrent_info.files().num_files()
            for selected_index in active_indexes:
                priorities[selected_index] = 7
            item.handle.prioritize_files(priorities)
        else:
            selected_files.pop(item.info_hash, None)
            hash_handles.pop(item.info_hash, None)
            hash_info.pop(item.info_hash, None)
            session.remove_torrent(item.handle, lt.options_t.delete_files)
            shutil.rmtree(ROOT / item.info_hash, ignore_errors=True)
    return {"success": True}


@app.delete("/torrents")
def remove_all():
    removed = 0
    for engine_id in list(torrents.keys()):
        try:
            remove(engine_id)
            removed += 1
        except Exception:
            pass
    return {"success": True, "removed": removed}


def cleanup_loop():
    while True:
        time.sleep(300)
        cutoff = time.time() - 12 * 60 * 60
        for engine_id, item in list(torrents.items()):
            if item.last_access < cutoff:
                try:
                    remove(engine_id)
                except Exception:
                    pass


threading.Thread(target=cleanup_loop, daemon=True).start()
