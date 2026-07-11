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
ROOT.mkdir(parents=True, exist_ok=True)
METADATA_TIMEOUT = int(os.environ.get("ENGINE_METADATA_TIMEOUT", "25"))
PIECE_TIMEOUT = int(os.environ.get("ENGINE_PIECE_TIMEOUT", "30"))

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


class PrepareRequest(BaseModel):
    infoHash: str
    fileIdx: Optional[int] = None
    sources: list[str] = Field(default_factory=list)


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
    query = "".join(f"&tr={quote(tracker, safe='')}" for tracker in trackers)
    return f"magnet:?xt=urn:btih:{request.infoHash}{query}"


def video_file(name: str) -> bool:
    return bool(re.search(r"\.(mkv|mp4|avi|mov|m4v|webm|ts)$", name, re.I))


def wait_metadata(handle):
    deadline = time.time() + METADATA_TIMEOUT
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
            "storage_mode": lt.storage_mode_t.storage_mode_sparse,
            "url": magnet_uri(request)
        }
        handle = session.add_torrent(params)
        with global_lock:
            hash_handles[info_hash] = handle

    try:
        if info is None:
            info = wait_metadata(handle)
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


def ensure_range(item: EngineTorrent, start: int, end: int):
    mapping = item.torrent_info.map_file(item.file_index, start, end - start + 1)
    piece_size = item.torrent_info.piece_length()
    first_piece = mapping.piece
    absolute_end = mapping.start + mapping.length - 1
    last_piece = min(item.torrent_info.num_pieces() - 1, first_piece + absolute_end // piece_size)

    with item.lock:
        for offset, piece in enumerate(range(first_piece, last_piece + 1)):
            item.handle.piece_priority(piece, 7)
            item.handle.set_piece_deadline(piece, offset * 250)

    deadline = time.time() + PIECE_TIMEOUT
    while time.time() < deadline:
        if all(item.handle.have_piece(piece) for piece in range(first_piece, last_piece + 1)):
            return
        status = item.handle.status()
        if status.errc.value() != 0:
            raise RuntimeError(status.errc.message())
        time.sleep(0.1)
    raise TimeoutError("Requested torrent pieces timed out")


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
