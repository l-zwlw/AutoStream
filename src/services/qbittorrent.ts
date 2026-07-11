const qbittorrentUrl = (
  process.env.QBITTORRENT_URL || "http://localhost:7002"
).replace(/\/$/, "");

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
};

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

export type FallbackOptions = {
  candidateTimeoutSeconds?: number;
  maximumCandidates?: number;
  minimumDownloadedKb?: number;
};

function normalizeFallbackOptions(options: FallbackOptions = {}) {
  return {
    candidateTimeoutMs: Math.min(
      Math.max(Number(options.candidateTimeoutSeconds || 6), 3),
      8
    ) * 1000,
    maximumCandidates: Math.min(
      Math.max(Number(options.maximumCandidates || 5), 1),
      10
    ),
    minimumDownloadedBytes: Math.min(
      Math.max(Number(options.minimumDownloadedKb || 256), 64),
      4096
    ) * 1024
  };
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const startupFallbackBudgetMs = 6_000;

async function apiRequest(path: string, init?: RequestInit) {
  return fetch(`${qbittorrentUrl}${path}`, {
    ...init,
    signal: AbortSignal.timeout(5000)
  });
}

function buildMagnet(candidate: TorrentCandidate) {
  const trackers = (candidate.sources || [])
    .filter((source) => source.startsWith("tracker:"))
    .map((source) => source.slice("tracker:".length));

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

async function addTorrent(candidate: TorrentCandidate) {
  const body = new URLSearchParams({
    urls: buildMagnet(candidate),
    savepath: "/downloads/autostream",
    category: "autostream",
    sequentialDownload: "true",
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

async function configureSelectedFile(
  infoHash: string,
  requestedFileIndex?: number
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

  await setFilePriority(
    infoHash,
    files
      .filter((file) => file.index !== selectedFile.index)
      .map((file) => file.index),
    0
  );
  await setFilePriority(infoHash, [selectedFile.index], 7);

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
          candidate.fileIdx
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
  deadline: number
) {
  const infoHash = candidate.infoHash!.toLowerCase();
  const existing = await getTorrent(infoHash);
  const createdByAutoStream = !existing;

  if (!existing) {
    await addTorrent(candidate);
  }

  const startedAt = Date.now();
  let selectedFileIndex: number | null = null;

  try {
    while (
      Date.now() - startedAt < options.candidateTimeoutMs &&
      Date.now() < deadline
    ) {
      const torrent = await getTorrent(infoHash);

      if (!torrent) {
        await delay(750);
        continue;
      }

      if (["error", "missingFiles", "unknown"].includes(torrent.state)) {
        return {
          success: false,
          reason: `qBittorrent state: ${torrent.state}`
        };
      }

      const hasMetadata = torrent.size > 0;

      if (hasMetadata && selectedFileIndex === null) {
        selectedFileIndex = await configureSelectedFile(
          infoHash,
          candidate.fileIdx
        );

        console.log(
          `qBittorrent restricted ${infoHash} to file index ${selectedFileIndex}`
        );
      }

      const selectedFile =
        selectedFileIndex === null
          ? null
          : (await getTorrentFiles(infoHash)).find(
              (file) => file.index === selectedFileIndex
            );
      const hasActivity =
        Boolean(selectedFile && selectedFile.progress > 0) &&
        (torrent.downloaded >= options.minimumDownloadedBytes ||
          torrent.dlspeed > 0);
      const hasPeers =
        torrent.num_seeds > 0 ||
        torrent.num_leechs > 0 ||
        torrent.downloaded >= torrent.size;

      if (hasMetadata && hasActivity && hasPeers) {
        return {
          success: true,
          reason: `ready with ${torrent.num_seeds} seeds at ${torrent.dlspeed} B/s`
        };
      }

      await delay(1000);
    }

    return {
      success: false,
      reason: `no usable data within ${options.candidateTimeoutMs / 1000} seconds`
    };
  } finally {
    if (createdByAutoStream) {
      await deleteTorrent(infoHash).catch(() => undefined);
    }
  }
}

export async function selectFirstPlayableTorrent(
  rankedStreams: TorrentCandidate[],
  fallbackOptions: FallbackOptions = {}
): Promise<FallbackSelection> {
  const options = normalizeFallbackOptions(fallbackOptions);
  const deadline = Date.now() + startupFallbackBudgetMs;
  const attempts: FallbackAttempt[] = [];
  const candidates = rankedStreams
    .filter((stream) =>
      typeof stream.infoHash === "string" &&
      /^[a-fA-F0-9]{40}$/.test(stream.infoHash)
    )
    .slice(0, options.maximumCandidates);

  for (const candidate of candidates) {
    if (Date.now() >= deadline) break;
    const infoHash = candidate.infoHash!.toLowerCase();

    try {
      const result = await testCandidate(candidate, options, deadline);

      attempts.push({
        infoHash,
        title: candidate.title || infoHash,
        success: result.success,
        reason: result.reason
      });

      console.log(
        `Fallback candidate ${result.success ? "accepted" : "rejected"}:`,
        candidate.title || infoHash,
        `(${result.reason})`
      );

      if (result.success) {
        return {
          stream: candidate,
          attempts
        };
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown error";

      attempts.push({
        infoHash,
        title: candidate.title || infoHash,
        success: false,
        reason
      });

      console.warn("Fallback candidate failed:", reason);
    }
  }

  return {
    stream: null,
    attempts
  };
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
