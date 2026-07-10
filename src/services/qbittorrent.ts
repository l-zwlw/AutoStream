const qbittorrentUrl = (
  process.env.QBITTORRENT_URL || "http://localhost:7002"
).replace(/\/$/, "");

export interface QBittorrentStatus {
  online: boolean;
  version: string | null;
  error: string | null;
}

type TorrentCandidate = {
  infoHash?: string;
  fileIdx?: number;
  sources?: string[];
  title?: string;
};

type TorrentInfo = {
  hash: string;
  state: string;
  downloaded: number;
  dlspeed: number;
  num_seeds: number;
  num_leechs: number;
  size: number;
};

type TorrentFile = {
  index: number;
  name: string;
  priority: number;
  progress: number;
  size: number;
};

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
      Math.max(Number(options.candidateTimeoutSeconds || 15), 5),
      60
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

async function getTorrentFiles(infoHash: string): Promise<TorrentFile[]> {
  const response = await apiRequest(
    `/api/v2/torrents/files?hash=${encodeURIComponent(infoHash)}`
  );

  if (!response.ok) {
    throw new Error(`qBittorrent files returned HTTP ${response.status}`);
  }

  return (await response.json()) as TorrentFile[];
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

async function testCandidate(
  candidate: TorrentCandidate,
  options: ReturnType<typeof normalizeFallbackOptions>
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
    while (Date.now() - startedAt < options.candidateTimeoutMs) {
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
  const attempts: FallbackAttempt[] = [];
  const candidates = rankedStreams
    .filter((stream) =>
      typeof stream.infoHash === "string" &&
      /^[a-fA-F0-9]{40}$/.test(stream.infoHash)
    )
    .slice(0, options.maximumCandidates);

  for (const candidate of candidates) {
    const infoHash = candidate.infoHash!.toLowerCase();

    try {
      const result = await testCandidate(candidate, options);

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
