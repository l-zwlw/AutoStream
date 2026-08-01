const metadataCache = new Map<string, { data: string; expiresAt: number }>();
const cacheLifetimeMs = 60 * 60 * 1000;

async function downloadMetadata(url: string, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(1_500);
  const response = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": "AutoStream torrent metadata resolver" },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout
  });
  if (!response.ok) throw new Error(`metadata cache returned HTTP ${response.status}`);
  const declaredSize = Number(response.headers.get("content-length") || 0);
  if (declaredSize > 8 * 1024 * 1024) throw new Error("torrent metadata is too large");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 32 || bytes.length > 8 * 1024 * 1024 || bytes[0] !== 0x64) {
    throw new Error("metadata cache did not return a bencoded torrent");
  }
  return bytes.toString("base64");
}

export async function resolveTorrentMetadata(
  infoHash: string,
  enabled = true,
  signal?: AbortSignal
) {
  if (!enabled || !/^[a-fA-F0-9]{40}$/.test(infoHash)) return undefined;
  const normalized = infoHash.toUpperCase();
  const cached = metadataCache.get(normalized);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const providers = [
    `https://itorrents.org/torrent/${normalized}.torrent`,
    `https://torrage.info/torrent.php?h=${normalized}`
  ];
  const data = await Promise.any(
    providers.map((url) => downloadMetadata(url, signal))
  ).catch(() => undefined);
  if (data) {
    metadataCache.set(normalized, { data, expiresAt: Date.now() + cacheLifetimeMs });
  }
  return data;
}
