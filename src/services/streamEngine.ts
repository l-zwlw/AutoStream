const engineUrl = (process.env.STREAM_ENGINE_URL || "http://localhost:7010").replace(/\/$/, "");

export type EngineCandidate = {
  infoHash?: string;
  fileIdx?: number;
  sources?: string[];
  title?: string;
  torrentData?: string;
};

export type EngineTorrent = {
  id: string;
  infoHash: string;
  fileIdx: number;
  fileName: string;
  fileSize: number;
  peers: number;
  downloadRate: number;
  streamUrl: string;
};

async function engineRequest(path: string, init?: RequestInit, timeoutMs = 35_000) {
  return fetch(`${engineUrl}${path}`, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs)
  });
}

export async function getStreamEngineStatus() {
  try {
    const response = await engineRequest("/health", undefined, 3_000);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { online: true, ...(await response.json() as any), error: null };
  } catch (error) {
    return {
      online: false,
      error: error instanceof Error ? error.message : "Stream engine unavailable"
    };
  }
}

export async function prepareEngineTorrent(candidate: EngineCandidate) {
  const response = await engineRequest("/prepare", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(candidate)
  });
  if (!response.ok) {
    throw new Error(`Stream engine prepare failed: ${await response.text()}`);
  }
  return await response.json() as EngineTorrent;
}

export async function probeEngineTorrent(
  candidate: EngineCandidate,
  requiredBytes: (fileSize: number) => number,
  timeoutMs: number,
  signal?: AbortSignal
) {
  try {
    const timeout = AbortSignal.timeout(Math.max(1000, timeoutMs + 1000));
    const response = await fetch(`${engineUrl}/probe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...candidate,
        timeoutMs,
        minimumDownloadedKb: Math.max(
          256,
          Math.ceil(requiredBytes(0) / 1024)
        )
      }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`playback probe returned HTTP ${response.status}: ${detail}`);
    }
    const result = await response.json() as {
      success: boolean;
      bytes: number;
      elapsedMs: number;
      fullyVerifiedPieces: boolean;
    };

    return {
      success: true,
      reason:
        `stream engine received ${result.bytes} requested start bytes ` +
        `${result.fullyVerifiedPieces ? "(piece verified)" : "(active payload)"} ` +
        `in ${(result.elapsedMs / 1000).toFixed(1)} seconds`,
      bytes: result.bytes
    };
  } catch (error) {
    return {
      success: false,
      reason:
        signal?.aborted
          ? "cancelled after another candidate succeeded"
          : error instanceof Error
            ? error.message
            : "stream engine probe failed",
      bytes: 0
    };
  }
}

export function engineStreamUrl(torrent: EngineTorrent) {
  return `${engineUrl}${torrent.streamUrl}`;
}

export async function removeEngineTorrent(id: string) {
  await engineRequest(`/torrents/${encodeURIComponent(id)}`, { method: "DELETE" }, 5_000);
}

export async function clearEngineTorrents() {
  const response = await engineRequest("/torrents", { method: "DELETE" }, 10_000);
  if (!response.ok) throw new Error(`Could not clear stream engine: HTTP ${response.status}`);
  return await response.json() as { success: boolean; removed: number };
}
