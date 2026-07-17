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

type MeasuredCandidate = {
  attempt: { success: boolean };
  averageSpeed: number;
  newlyDownloadedBytes: number;
  rank: number;
};

export function fastestSuccessfulCandidate<T extends MeasuredCandidate>(
  candidates: T[]
) {
  return [...candidates]
    .filter((candidate) => candidate.attempt.success)
    .sort(
      (a, b) =>
        b.averageSpeed - a.averageSpeed ||
        b.newlyDownloadedBytes - a.newlyDownloadedBytes ||
        a.rank - b.rank
    )[0] || null;
}

export type FallbackOptions = {
  candidateTimeoutSeconds?: number;
  maximumCandidates?: number;
  minimumDownloadedKb?: number;
};

function normalizeFallbackOptions(options: FallbackOptions = {}) {
  return {
    candidateTimeoutMs: Math.min(
      Math.max(Number(options.candidateTimeoutSeconds || 20), 20),
      30
    ) * 1000,
    maximumCandidates: Math.min(
      Math.max(Number(options.maximumCandidates || 10), 10),
      20
    ),
    minimumDownloadedBytes: Math.min(
      Math.max(Number(options.minimumDownloadedKb || 1024), 1024),
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
  let downloadedBaseline: number | null = null;
  let measurementStartedAt: number | null = null;

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
          candidate.fileIdx
        );
        metadataReady = true;

        // qBittorrent can keep an individual file's `progress` at zero while
        // pieces for that file are already arriving. Measure fresh torrent
        // bytes only after every other file has been disabled instead. This
        // also prevents metadata or previously downloaded pack data from
        // making a candidate look healthy.
        const configuredTorrent = await getTorrent(infoHash);
        downloadedBaseline = configuredTorrent?.downloaded ?? torrent.downloaded;
        measurementStartedAt = Date.now();

        console.log(
          `qBittorrent restricted ${infoHash} to file index ${selectedFileIndex}`,
          `(baseline ${downloadedBaseline} bytes)`
        );
      }

      const selectedFile =
        selectedFileIndex === null
          ? null
          : (await getTorrentFiles(infoHash)).find(
              (file) => file.index === selectedFileIndex
            );
      const newlyDownloadedBytes =
        downloadedBaseline === null
          ? 0
          : Math.max(0, torrent.downloaded - downloadedBaseline);
      const measurementSeconds =
        measurementStartedAt === null
          ? 0
          : Math.max((Date.now() - measurementStartedAt) / 1000, 0.001);
      const averageSpeed = newlyDownloadedBytes / measurementSeconds;
      const hasActivity =
        Boolean(selectedFile && selectedFile.priority > 0) &&
        newlyDownloadedBytes >= options.minimumDownloadedBytes &&
        measurementSeconds >= 4;
      const hasPeers =
        torrent.num_seeds > 0 ||
        torrent.num_leechs > 0 ||
        torrent.downloaded >= torrent.size;

      if (hasMetadata && hasActivity && hasPeers) {
        return {
          success: true,
          reason: `downloaded ${newlyDownloadedBytes} verified bytes from ${torrent.num_seeds} seeds at ${Math.round(averageSpeed)} B/s average`,
          metadataReady: true,
          newlyDownloadedBytes,
          averageSpeed
        };
      }

      await delay(1000);
    }

    return {
      success: false,
      reason: signal?.aborted
        ? "cancelled after another candidate succeeded"
        : `no usable data within ${options.candidateTimeoutMs / 1000} seconds`,
      metadataReady,
      newlyDownloadedBytes: 0,
      averageSpeed: 0
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
  const validCandidates = rankedStreams
    .filter((stream) =>
      typeof stream.infoHash === "string" &&
      /^[a-fA-F0-9]{40}$/.test(stream.infoHash)
    );
  // rankStreams already compares every addon globally. Preserve that order
  // here: interleaving one result per quality promoted weak 4K/1080p torrents
  // over healthier 720p candidates and made fallback less predictable.
  const candidates = validCandidates.slice(0, options.maximumCandidates);
  if (!candidates.length) {
    return { stream: null, attempts: [] };
  }
  type TestedCandidate = {
    candidate: TorrentCandidate;
    metadataReady: boolean;
    rank: number;
    newlyDownloadedBytes: number;
    averageSpeed: number;
    attempt: FallbackAttempt;
  };
  const attempts: FallbackAttempt[] = [];

  // Four candidates include the best practical alternatives across common
  // quality levels without overloading a typical home server.
  // Duplicate Stremio requests share this race in streams.ts.
  const batchSize = Math.min(4, candidates.length);
  for (let offset = 0; offset < candidates.length; offset += batchSize) {
    const batch = candidates.slice(offset, offset + batchSize);
    const deadline = Date.now() + options.candidateTimeoutMs;
    const probeController = new AbortController();
    let remaining = batch.length;
    let settled = false;
    let resolveWinner: (value: TestedCandidate | null) => void = () => undefined;
    const firstSuccess = new Promise<TestedCandidate | null>((resolve) => {
      resolveWinner = resolve;
    });

    const successfulCandidates: TestedCandidate[] = [];
    const tasks = batch.map(async (candidate, batchIndex): Promise<TestedCandidate> => {
      const infoHash = candidate.infoHash!.toLowerCase();
      let tested: TestedCandidate;
      try {
        const result = await testCandidate(
          candidate,
          options,
          deadline,
          probeController.signal
        );
        tested = {
          candidate,
          metadataReady: result.metadataReady,
          rank: offset + batchIndex,
          newlyDownloadedBytes: result.newlyDownloadedBytes || 0,
          averageSpeed: result.averageSpeed || 0,
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
          metadataReady: false,
          rank: offset + batchIndex,
          newlyDownloadedBytes: 0,
          averageSpeed: 0,
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
      remaining -= 1;

      if (tested.attempt.success) {
        successfulCandidates.push(tested);
      }

      if (!settled && tested.attempt.success) {
        settled = true;
        resolveWinner(tested);
      } else if (!settled && remaining === 0) {
        settled = true;
        resolveWinner(null);
      }

      return tested;
    });

    const winner = await firstSuccess;
    if (winner) {
      // The first stream to become playable starts a short grace period. This
      // keeps startup quick while allowing another already-active candidate to
      // prove that it has materially better sustained throughput.
      await Promise.race([
        Promise.allSettled(tasks),
        delay(2_000)
      ]);
      probeController.abort();
    }
    await Promise.allSettled(tasks);
    if (winner) {
      const fastest = fastestSuccessfulCandidate(successfulCandidates) || winner;
      return { stream: fastest.candidate, attempts };
    }
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
