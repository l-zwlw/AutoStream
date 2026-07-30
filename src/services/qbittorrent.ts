import {
  getStreamEngineStatus,
  probeEngineTorrent
} from "./streamEngine";

const qbittorrentUrl = (
  process.env.QBITTORRENT_URL || "http://localhost:7002"
).replace(/\/$/, "");

// Many Stremio addons return only an info hash. A fresh AutoStream install
// cannot rely on a warmed-up DHT yet, so include a small, diverse tracker set
// when the source addon does not provide one. Duplicate trackers are removed.
const DEFAULT_TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.stealth.si:80/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "udp://exodus.desync.com:6969/announce",
  "https://tracker.opentrackr.org:443/announce"
];

export function torrentSourcesWithDefaults(sources: string[] = []) {
  const suppliedSources = sources.filter(
    (source) => typeof source === "string" && source.trim()
  );
  const trackerSources = DEFAULT_TRACKERS.map(
    (tracker) => `tracker:${tracker}`
  );
  return [...new Set([...suppliedSources, ...trackerSources])];
}

export interface QBittorrentStatus {
  online: boolean;
  version: string | null;
  error: string | null;
}

export type TorrentCandidate = {
  infoHash?: string;
  fileIdx?: number;
  sources?: string[];
  title?: string;
};

type TorrentInfo = {
  hash: string;
  name: string;
  state: string;
  downloaded: number;
  dlspeed: number;
  num_seeds: number;
  num_leechs: number;
  size: number;
  content_path: string;
  save_path: string;
  seq_dl: boolean;
  f_l_piece_prio: boolean;
  category: string;
};

export type TorrentSummary = Pick<
  TorrentInfo,
  "hash" | "name" | "state" | "downloaded" | "dlspeed" | "size"
>;

type TorrentFile = {
  index: number;
  name: string;
  priority: number;
  progress: number;
  size: number;
  piece_range?: [number, number];
};

type TorrentProperties = {
  piece_size: number;
};

export interface PreparedTorrent {
  infoHash: string;
  fileIndex: number;
  fileName: string;
  filePath: string;
  fileSize: number;
  createdByAutoStream: boolean;
}

export interface FallbackAttempt {
  infoHash: string;
  title: string;
  success: boolean;
  reason: string;
}

export interface FallbackSelection {
  stream: TorrentCandidate | null;
  attempts: FallbackAttempt[];
}

function candidateQuality(candidate: TorrentCandidate) {
  const text = String(candidate.title || "");
  if (/2160p|\b4k\b/i.test(text)) return "4k";
  if (/1080p/i.test(text)) return "1080p";
  if (/720p/i.test(text)) return "720p";
  return "other";
}

export function requiredVideoProofBytes(
  fileSize: number,
  configuredMinimumBytes: number
) {
  const proportionalBytes = Math.ceil(Math.max(0, fileSize) * 0.0001);

  return Math.min(
    4 * 1024 * 1024,
    Math.max(256 * 1024, configuredMinimumBytes, proportionalBytes)
  );
}

export function contiguousReadyBytes(
  pieceStates: number[],
  firstPiece: number,
  lastPiece: number,
  pieceSize: number,
  fileSize: number
) {
  if (
    !Number.isFinite(firstPiece) ||
    !Number.isFinite(lastPiece) ||
    !Number.isFinite(pieceSize) ||
    pieceSize <= 0 ||
    firstPiece < 0 ||
    lastPiece < firstPiece
  ) {
    return 0;
  }

  let readyPieces = 0;
  for (let index = firstPiece; index <= lastPiece; index += 1) {
    if (pieceStates[index] !== 2) break;
    readyPieces += 1;
  }

  return Math.min(Math.max(0, fileSize), readyPieces * pieceSize);
}

export function verificationCandidateOrder<T extends TorrentCandidate>(
  candidates: T[]
) {
  const buckets = new Map<string, T[]>([
    ["1080p", []],
    ["720p", []],
    ["4k", []],
    ["other", []]
  ]);
  for (const candidate of candidates) {
    buckets.get(candidateQuality(candidate))!.push(candidate);
  }
  for (const [quality, bucket] of buckets) {
    // Jackett represents the user's own indexers and may expose healthy swarms
    // that public addons rank poorly or do not list at all. Give those results
    // the first verification slots within the same quality, while preserving
    // the statistical order inside both source groups. Measurement still
    // decides the winner, so an unhealthy Jackett result never wins blindly.
    buckets.set(quality, [
      ...bucket.filter(
        (candidate: any) => candidate._autostreamAddonId === "jackett"
      ),
      ...bucket.filter(
        (candidate: any) => candidate._autostreamAddonId !== "jackett"
      )
    ]);
  }
  const ordered: T[] = [];
  const practicalBuckets = [buckets.get("1080p")!, buckets.get("720p")!];
  while (practicalBuckets.some((bucket) => bucket.length)) {
    for (const bucket of practicalBuckets) {
      const candidate = bucket.shift();
      if (candidate) ordered.push(candidate);
    }
  }
  ordered.push(...buckets.get("4k")!, ...buckets.get("other")!);
  return ordered;
}

export function oneCandidatePerQuality<T extends TorrentCandidate>(
  candidates: T[]
) {
  const selected: T[] = [];
  const seen = new Set<string>();

  for (const candidate of verificationCandidateOrder(candidates)) {
    const quality = candidateQuality(candidate);
    if (seen.has(quality)) continue;
    seen.add(quality);
    selected.push(candidate);
  }

  return selected;
}

export function verificationCandidatesByWave<T extends TorrentCandidate>(
  candidates: T[],
  maximumCandidates: number
) {
  const ordered = verificationCandidateOrder(candidates);
  const qualityOrder = ["1080p", "720p", "4k", "other"];
  const buckets = new Map(
    qualityOrder.map((quality) => [
      quality,
      ordered.filter((candidate) => candidateQuality(candidate) === quality)
    ])
  );
  const plan: Array<{ candidate: T; wave: number }> = [];
  let wave = 0;

  while (
    plan.length < Math.max(0, maximumCandidates) &&
    qualityOrder.some((quality) => buckets.get(quality)!.length > 0)
  ) {
    for (const quality of qualityOrder) {
      if (plan.length >= maximumCandidates) break;
      const candidate = buckets.get(quality)!.shift();
      if (candidate) plan.push({ candidate, wave });
    }
    wave += 1;
  }

  return plan;
}

export type FallbackOptions = {
  candidateTimeoutSeconds?: number;
  maximumCandidates?: number;
  minimumDownloadedKb?: number;
};

function normalizeFallbackOptions(options: FallbackOptions = {}) {
  return {
    candidateTimeoutMs: Math.min(
      Math.max(Number(options.candidateTimeoutSeconds || 18), 8),
      20
    ) * 1000,
    maximumCandidates: Math.min(
      Math.max(Number(options.maximumCandidates || 10), 10),
      20
    ),
    minimumDownloadedBytes: Math.min(
      Math.max(Number(options.minimumDownloadedKb || 256), 256),
      16384
    ) * 1024
  };
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function apiRequest(path: string, init?: RequestInit) {
  return fetch(`${qbittorrentUrl}${path}`, {
    ...init,
    signal: AbortSignal.timeout(5000)
  });
}

function buildMagnet(candidate: TorrentCandidate) {
  const suppliedTrackers = torrentSourcesWithDefaults(candidate.sources || [])
    .filter((source) => source.startsWith("tracker:"))
    .map((source) => source.slice("tracker:".length))
    .filter(Boolean);
  const trackers = [...new Set(suppliedTrackers)];

  const trackerQuery = trackers
    .map((tracker) => `&tr=${encodeURIComponent(tracker)}`)
    .join("");

  return `magnet:?xt=urn:btih:${candidate.infoHash}${trackerQuery}`;
}

export async function getTorrent(infoHash: string): Promise<TorrentInfo | null> {
  const response = await apiRequest(
    `/api/v2/torrents/info?hashes=${encodeURIComponent(infoHash)}`
  );

  if (!response.ok) {
    throw new Error(`qBittorrent info returned HTTP ${response.status}`);
  }

  const torrents = (await response.json()) as TorrentInfo[];

  return torrents[0] || null;
}

export async function getAutoStreamTorrents(): Promise<TorrentSummary[]> {
  const response = await apiRequest(
    "/api/v2/torrents/info?category=autostream"
  );
  if (!response.ok) {
    throw new Error(`qBittorrent list returned HTTP ${response.status}`);
  }
  return (await response.json()) as TorrentSummary[];
}

export async function clearAutoStreamTorrents() {
  const torrents = await getAutoStreamTorrents();
  await Promise.all(torrents.map((torrent) => deleteTorrent(torrent.hash)));
  return torrents.length;
}

async function addTorrent(candidate: TorrentCandidate) {
  const body = new URLSearchParams({
    urls: buildMagnet(candidate),
    savepath: "/downloads/autostream",
    category: "autostream",
    sequentialDownload: "true",
    // The first piece must be requested immediately. The last piece may also
    // be useful for media-container metadata, but it never counts toward the
    // contiguous playback proof.
    firstLastPiecePrio: "true"
  });

  const response = await apiRequest("/api/v2/torrents/add", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  if (!response.ok) {
    throw new Error(`qBittorrent add returned HTTP ${response.status}`);
  }
}

async function exportTorrent(infoHash: string) {
  const response = await apiRequest(
    `/api/v2/torrents/export?hash=${encodeURIComponent(infoHash)}`
  );
  if (!response.ok) {
    throw new Error(`qBittorrent export returned HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer()).toString("base64");
}

async function getCandidateTorrentMetadata(
  candidate: TorrentCandidate,
  deadline: number,
  signal?: AbortSignal
) {
  const infoHash = candidate.infoHash!.toLowerCase();
  let existing = await getTorrent(infoHash);
  const managedByAutoStream = !existing || existing.category === "autostream";
  if (existing?.category === "autostream") {
    await deleteTorrent(infoHash);
    await delay(150);
    existing = null;
  }
  if (!existing) await addTorrent(candidate);

  try {
    while (Date.now() < deadline && !signal?.aborted) {
      const torrent = await getTorrent(infoHash);
      if (torrent && torrent.size > 0) {
        return await exportTorrent(infoHash);
      }
      await delay(250);
    }
    throw new Error(
      signal?.aborted
        ? "cancelled after another candidate succeeded"
        : "torrent metadata did not arrive in time"
    );
  } finally {
    if (managedByAutoStream) {
      await deleteTorrent(infoHash).catch(() => undefined);
    }
  }
}

function isVideoFile(filename: string) {
  return /\.(mkv|mp4|avi|mov|m4v|webm|ts)$/i.test(filename);
}

export async function getTorrentFiles(infoHash: string): Promise<TorrentFile[]> {
  const response = await apiRequest(
    `/api/v2/torrents/files?hash=${encodeURIComponent(infoHash)}`
  );

  if (!response.ok) {
    throw new Error(`qBittorrent files returned HTTP ${response.status}`);
  }

  return (await response.json()) as TorrentFile[];
}

async function getTorrentProperties(infoHash: string): Promise<TorrentProperties> {
  const response = await apiRequest(
    `/api/v2/torrents/properties?hash=${encodeURIComponent(infoHash)}`
  );

  if (!response.ok) {
    throw new Error(`qBittorrent properties returned HTTP ${response.status}`);
  }

  return (await response.json()) as TorrentProperties;
}

async function getPieceStates(infoHash: string): Promise<number[]> {
  const response = await apiRequest(
    `/api/v2/torrents/pieceStates?hash=${encodeURIComponent(infoHash)}`
  );

  if (!response.ok) {
    throw new Error(`qBittorrent piece states returned HTTP ${response.status}`);
  }

  return (await response.json()) as number[];
}

function getTorrentFilePath(
  torrent: TorrentInfo,
  files: TorrentFile[],
  selectedFile: TorrentFile
) {
  if (files.length === 1) {
    return torrent.content_path || `${torrent.save_path}/${selectedFile.name}`;
  }

  const rootPath =
    torrent.content_path || `${torrent.save_path}/${torrent.name}`;

  return `${rootPath.replace(/\/$/, "")}/${selectedFile.name}`;
}

async function setFilePriority(
  infoHash: string,
  fileIndexes: number[],
  priority: number
) {
  if (!fileIndexes.length) return;

  const response = await apiRequest("/api/v2/torrents/filePrio", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      hash: infoHash,
      id: fileIndexes.join("|"),
      priority: String(priority)
    })
  });

  if (!response.ok) {
    throw new Error(`qBittorrent file priority returned HTTP ${response.status}`);
  }
}

async function toggleTorrentOption(infoHash: string, endpoint: string) {
  const response = await apiRequest(`/api/v2/torrents/${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({ hashes: infoHash })
  });

  if (!response.ok) {
    throw new Error(
      `qBittorrent ${endpoint} returned HTTP ${response.status}`
    );
  }
}

async function ensureStreamingPriorities(
  infoHash: string,
  prioritizeLastPiece: boolean
) {
  const torrent = await getTorrent(infoHash);
  if (!torrent) {
    throw new Error("Torrent disappeared while setting streaming priorities");
  }

  // The add API options are not applied reliably by every qBittorrent build.
  // Read the actual state and explicitly enable both options when necessary.
  if (!torrent.seq_dl) {
    await toggleTorrentOption(infoHash, "toggleSequentialDownload");
  }
  if (torrent.f_l_piece_prio !== prioritizeLastPiece) {
    await toggleTorrentOption(infoHash, "toggleFirstLastPiecePrio");
  }
}

async function configureSelectedFile(
  infoHash: string,
  requestedFileIndex?: number,
  prioritizeLastPiece = false
) {
  const files = await getTorrentFiles(infoHash);
  const requestedFile =
    typeof requestedFileIndex === "number"
      ? files.find(
          (file) =>
            file.index === requestedFileIndex &&
            isVideoFile(file.name)
        )
      : undefined;

  if (typeof requestedFileIndex === "number" && !requestedFile) {
    throw new Error(
      `Requested video file index ${requestedFileIndex} was not found`
    );
  }

  const selectedFile =
    requestedFile ||
    [...files]
      .filter((file) => isVideoFile(file.name))
      .sort((a, b) => b.size - a.size)[0];

  if (!selectedFile) {
    throw new Error("No playable video file found in torrent");
  }

  // Metadata acquisition may already have queued random piece requests for
  // every file. Merely changing priorities does not cancel those requests,
  // which can leave the actual beginning of the selected video incomplete
  // while megabytes of unrelated pieces arrive. Stop and restart around the
  // priority change so libtorrent builds a clean sequential request queue.
  await stopTorrent(infoHash);
  await delay(250);
  try {
    await setFilePriority(
      infoHash,
      files
        .filter((file) => file.index !== selectedFile.index)
        .map((file) => file.index),
      0
    );
    await setFilePriority(infoHash, [selectedFile.index], 7);
    await ensureStreamingPriorities(infoHash, prioritizeLastPiece);
  } finally {
    await startTorrent(infoHash);
  }

  return selectedFile.index;
}

export async function deleteTorrent(infoHash: string) {
  const body = new URLSearchParams({
    hashes: infoHash,
    deleteFiles: "true"
  });

  await apiRequest("/api/v2/torrents/delete", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });
}

async function torrentAction(infoHash: string, modernPath: string, legacyPath: string) {
  const body = new URLSearchParams({ hashes: infoHash });
  const request = (actionPath: string) =>
    apiRequest(`/api/v2/torrents/${actionPath}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body
    });

  const modernResponse = await request(modernPath);

  if (modernResponse.ok) return;

  const legacyResponse = await request(legacyPath);

  if (!legacyResponse.ok) {
    throw new Error(
      `qBittorrent ${modernPath} returned HTTP ${modernResponse.status}`
    );
  }
}

export async function stopTorrent(infoHash: string) {
  await torrentAction(infoHash, "stop", "pause");
}

export async function startTorrent(infoHash: string) {
  await torrentAction(infoHash, "start", "resume");
}

export async function prepareStreamingCandidate(
  candidate: TorrentCandidate,
  fallbackOptions: FallbackOptions = {},
  prebufferBytes = 16 * 1024 * 1024
): Promise<PreparedTorrent> {
  if (
    typeof candidate.infoHash !== "string" ||
    !/^[a-fA-F0-9]{40}$/.test(candidate.infoHash)
  ) {
    throw new Error("Streaming candidate has no valid info hash");
  }

  const options = normalizeFallbackOptions(fallbackOptions);
  const infoHash = candidate.infoHash.toLowerCase();
  const existing = await getTorrent(infoHash);
  const createdByAutoStream = !existing;

  if (!existing) {
    await addTorrent(candidate);
  }

  const startedAt = Date.now();
  let selectedFileIndex: number | null = null;

  try {
    while (Date.now() - startedAt < Math.max(options.candidateTimeoutMs, 15_000)) {
      const torrent = await getTorrent(infoHash);

      if (!torrent) {
        await delay(750);
        continue;
      }

      if (["error", "missingFiles", "unknown"].includes(torrent.state)) {
        throw new Error(`qBittorrent state: ${torrent.state}`);
      }

      if (torrent.size > 0 && selectedFileIndex === null) {
        selectedFileIndex = await configureSelectedFile(
          infoHash,
          candidate.fileIdx,
          true
        );
      }

      if (selectedFileIndex !== null) {
        const files = await getTorrentFiles(infoHash);
        const selectedFile = files.find(
          (file) => file.index === selectedFileIndex
        );

        if (!selectedFile) {
          throw new Error("Selected torrent file disappeared");
        }

        const targetBytes = Math.min(
          selectedFile.size,
          Math.max(prebufferBytes, options.minimumDownloadedBytes)
        );
        const downloadedBytes = selectedFile.progress * selectedFile.size;
        let playableRangeReady = downloadedBytes >= targetBytes;

        if (selectedFile.piece_range) {
          const [firstPiece, lastPiece] = selectedFile.piece_range;
          const [properties, pieceStates] = await Promise.all([
            getTorrentProperties(infoHash),
            getPieceStates(infoHash)
          ]);
          const requiredPieces = Math.max(
            1,
            Math.ceil(targetBytes / properties.piece_size)
          );
          const requiredLastPiece = Math.min(
            lastPiece,
            firstPiece + requiredPieces - 1
          );
          const firstRangeReady = pieceStates
            .slice(firstPiece, requiredLastPiece + 1)
            .every((state) => state === 2);
          const finalPieceReady = pieceStates[lastPiece] === 2;

          playableRangeReady = firstRangeReady && finalPieceReady;
        }

        if (playableRangeReady) {
          return {
            infoHash,
            fileIndex: selectedFile.index,
            fileName: selectedFile.name,
            filePath: getTorrentFilePath(torrent, files, selectedFile),
            fileSize: selectedFile.size,
            createdByAutoStream
          };
        }
      }

      await delay(1000);
    }

    throw new Error("Streaming prebuffer timed out");
  } catch (error) {
    if (createdByAutoStream) {
      await deleteTorrent(infoHash).catch(() => undefined);
    }

    throw error;
  }
}

async function testCandidate(
  candidate: TorrentCandidate,
  options: ReturnType<typeof normalizeFallbackOptions>,
  deadline: number,
  signal?: AbortSignal
) {
  const infoHash = candidate.infoHash!.toLowerCase();
  const existing = await getTorrent(infoHash);
  const createdByAutoStream = !existing;

  if (!existing) {
    await addTorrent(candidate);
  }

  const startedAt = Date.now();
  let selectedFileIndex: number | null = null;
  let metadataReady = false;
  let lastContiguousBytes = 0;
  let lastRequiredProofBytes = options.minimumDownloadedBytes;
  let lastSeeds = 0;

  try {
    while (
      Date.now() - startedAt < options.candidateTimeoutMs &&
      Date.now() < deadline &&
      !signal?.aborted
    ) {
      const torrent = await getTorrent(infoHash);

      if (!torrent) {
        await delay(750);
        continue;
      }

      if (["error", "missingFiles", "unknown"].includes(torrent.state)) {
        return {
          success: false,
          reason: `qBittorrent state: ${torrent.state}`,
          metadataReady
        };
      }

      const hasMetadata = torrent.size > 0;

      if (hasMetadata && selectedFileIndex === null) {
        selectedFileIndex = await configureSelectedFile(
          infoHash,
          candidate.fileIdx,
          true
        );
        metadataReady = true;
        console.log(
          `qBittorrent restricted ${infoHash} to file index ${selectedFileIndex}`,
          "(sequential start-data verification)"
        );
      }

      const selectedFile =
        selectedFileIndex === null
          ? null
          : (await getTorrentFiles(infoHash)).find(
              (file) => file.index === selectedFileIndex
            );
      lastSeeds = torrent.num_seeds;
      const requiredProofBytes = requiredVideoProofBytes(
        selectedFile?.size || 0,
        options.minimumDownloadedBytes
      );
      lastRequiredProofBytes = requiredProofBytes;
      let contiguousBytes = 0;
      if (selectedFile?.piece_range) {
        const [firstPiece, lastPiece] = selectedFile.piece_range;
        const [properties, pieceStates] = await Promise.all([
          getTorrentProperties(infoHash),
          getPieceStates(infoHash)
        ]);
        contiguousBytes = contiguousReadyBytes(
          pieceStates,
          firstPiece,
          lastPiece,
          properties.piece_size,
          selectedFile.size
        );
      }
      lastContiguousBytes = contiguousBytes;

      // Seeder counts, estimated speed and total torrent progress never decide
      // the winner. Only verified, contiguous bytes from the beginning of the
      // exact requested video file count as playable proof.
      const hasPlayableStart =
        Boolean(selectedFile && selectedFile.priority > 0) &&
        contiguousBytes >= requiredProofBytes;
      const hasPeers =
        torrent.num_seeds > 0 ||
        torrent.num_leechs > 0 ||
        torrent.downloaded >= torrent.size;

      if (hasMetadata && hasPlayableStart && hasPeers) {
        return {
          success: true,
          reason:
            `selected video file delivered ${contiguousBytes} contiguous start bytes ` +
            `(required ${requiredProofBytes})`,
          metadataReady: true,
          contiguousBytes
        };
      }

      await delay(1000);
    }

    return {
      success: false,
      reason: signal?.aborted
        ? "cancelled after another candidate succeeded"
        : `no usable data within ${options.candidateTimeoutMs / 1000} seconds ` +
          `(contiguous start ${lastContiguousBytes}/${lastRequiredProofBytes} ` +
          `bytes, seeds ${lastSeeds})`,
      metadataReady,
      contiguousBytes: lastContiguousBytes
    };
  } finally {
    if (createdByAutoStream) {
      await deleteTorrent(infoHash).catch(() => undefined);
    }
  }
}

async function testCandidateWithStreamEngine(
  candidate: TorrentCandidate,
  options: ReturnType<typeof normalizeFallbackOptions>,
  deadline: number,
  signal?: AbortSignal
) {
  const remainingMs = Math.max(
    1000,
    Math.min(options.candidateTimeoutMs, deadline - Date.now())
  );
  return probeEngineTorrent(
    candidate,
    (fileSize) =>
      requiredVideoProofBytes(fileSize, options.minimumDownloadedBytes),
    remainingMs,
    signal
  );
}

export async function selectFirstPlayableTorrent(
  rankedStreams: TorrentCandidate[],
  fallbackOptions: FallbackOptions = {},
  externalSignal?: AbortSignal
): Promise<FallbackSelection> {
  const options = normalizeFallbackOptions(fallbackOptions);
  const validCandidates = rankedStreams
    .filter((stream) =>
      typeof stream.infoHash === "string" &&
      /^[a-fA-F0-9]{40}$/.test(stream.infoHash)
    );
  const candidatePlan = verificationCandidatesByWave(
    validCandidates,
    options.maximumCandidates
  );
  if (!candidatePlan.length) {
    return { stream: null, attempts: [] };
  }
  type TestedCandidate = {
    candidate: TorrentCandidate;
    attempt: FallbackAttempt;
  };
  const attempts: FallbackAttempt[] = [];

  // Test exactly one torrent per quality in each round. Only when every
  // quality in that round fails do we advance to the next candidates. A fast
  // verified winner returns immediately; old swarms may use the full round.
  const selectionDeadline =
    Date.now() + Math.min(30_000, options.candidateTimeoutMs * 2);
  const streamEngine = await getStreamEngineStatus();
  const waves = new Map<number, TorrentCandidate[]>();
  for (const { candidate, wave } of candidatePlan) {
    const candidates = waves.get(wave) || [];
    candidates.push(candidate);
    waves.set(wave, candidates);
  }

  for (const waveCandidates of waves.values()) {
    if (Date.now() >= selectionDeadline || externalSignal?.aborted) break;
    const probeController = new AbortController();
    const probeSignal = externalSignal
      ? AbortSignal.any([externalSignal, probeController.signal])
      : probeController.signal;
    const waveDeadline = Math.min(
      selectionDeadline,
      Date.now() + options.candidateTimeoutMs
    );
    const tasks = waveCandidates.map(async (candidate) => {
      const infoHash = candidate.infoHash!.toLowerCase();
      let tested: TestedCandidate;
      try {
        const result = streamEngine.online
          ? await testCandidateWithStreamEngine(
              candidate,
              options,
              waveDeadline,
              probeSignal
            )
          : await testCandidate(
              candidate,
              options,
              waveDeadline,
              probeSignal
            );
        tested = {
          candidate,
          attempt: {
            infoHash,
            title: candidate.title || infoHash,
            success: result.success,
            reason: result.reason
          }
        };
      } catch (error) {
        const reason = error instanceof Error ? error.message : "Unknown error";
        tested = {
          candidate,
          attempt: {
            infoHash,
            title: candidate.title || infoHash,
            success: false,
            reason
          }
        };
      }

      console.log(
        `Fallback candidate ${tested.attempt.success ? "accepted" : "rejected"}:`,
        tested.attempt.title,
        `(${tested.attempt.reason})`
      );
      attempts.push(tested.attempt);
      return tested.attempt.success ? tested : null;
    });

    const winner = await Promise.any(
      tasks.map(async (task) => {
        const tested = await task;
        if (!tested) throw new Error("candidate failed");
        return tested;
      })
    ).catch(() => null);
    if (winner) {
      probeController.abort();
      void Promise.allSettled(tasks);
      return { stream: winner.candidate, attempts };
    }
    await Promise.allSettled(tasks);
  }

  return { stream: null, attempts };
}

export async function getQBittorrentStatus(): Promise<QBittorrentStatus> {
  try {
    const response = await fetch(
      `${qbittorrentUrl}/api/v2/app/version`,
      {
        signal: AbortSignal.timeout(3000)
      }
    );

    if (!response.ok) {
      return {
        online: false,
        version: null,
        error: `qBittorrent returned HTTP ${response.status}`
      };
    }

    return {
      online: true,
      version: (await response.text()).trim(),
      error: null
    };
  } catch (error) {
    return {
      online: false,
      version: null,
      error:
        error instanceof Error
          ? error.message
          : "Could not connect to qBittorrent"
    };
  }
}
