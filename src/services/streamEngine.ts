const engineUrl = (process.env.STREAM_ENGINE_URL || "http://localhost:7010").replace(/\/$/, "");

export type EngineCandidate = {
  infoHash?: string;
  fileIdx?: number;
  sources?: string[];
  title?: string;
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
