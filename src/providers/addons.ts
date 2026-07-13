import { getAddons } from "../services/addons";
import { recordAddonResult, shouldTemporarilySkipAddon } from "../services/health";

const streamCache = new Map<string, { streams: any[]; expiresAt: number }>();
const cacheLifetimeMs = 10 * 60 * 1000;

async function fetchAddonStreams(url: string) {
  // A dead secondary addon must never hold the entire Stremio response open.
  // Healthy addons normally answer in well under a second; cached results are
  // still used by the caller when this short live request fails.
  const response = await fetch(url, { signal: AbortSignal.timeout(2_500) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data: any = await response.json();
  return Array.isArray(data.streams) ? data.streams : [];
}

export async function getAddonStreams(
  type: string,
  id: string,
  allowedAddonIds?: string[],
  selectionConfigured = false
) {
  const enabledAddons = getAddons().filter(
    (addon: any) =>
      addon.enabled !== false &&
      (!selectionConfigured || allowedAddonIds?.includes(addon.instanceId))
  );
  // Never suppress the viewer's only source because of one temporary failure.
  const addons = enabledAddons.filter(
    (addon: any) => enabledAddons.length === 1 || !shouldTemporarilySkipAddon(addon.id)
  );
  const loadAddon = async (addon: any) => {
    try {
      const startedAt = Date.now();
      const url = `${addon.url}/stream/${type}/${id}.json`;
      const cacheKey = `${addon.instanceId}:${type}:${id}`;

      console.log("Loading addon:", url);

      const streams = await fetchAddonStreams(url);

      if (streams.length) {
        streamCache.set(cacheKey, {
          streams,
          expiresAt: Date.now() + cacheLifetimeMs
        });
        recordAddonResult(addon.instanceId, {
          success: true,
          latencyMs: Date.now() - startedAt,
          streams: streams.length
        });
        return streams.map((stream: any) => ({
          ...stream,
          _autostreamAddonId: addon.instanceId,
          _autostreamAddonName: addon.name
        }));
      }
      recordAddonResult(addon.instanceId, {
        success: true,
        latencyMs: Date.now() - startedAt,
        streams: 0
      });
      return [];
    } catch (error) {
      const cacheKey = `${addon.instanceId}:${type}:${id}`;
      const cached = streamCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        console.warn("Addon failed; using cached streams:", addon.name || addon.url);
        return cached.streams.map((stream: any) => ({
          ...stream,
          _autostreamAddonId: addon.instanceId,
          _autostreamAddonName: addon.name
        }));
      }
      console.warn("Addon failed:", addon.name || addon.url, error instanceof Error ? error.message : error);
      recordAddonResult(addon.instanceId, {
        success: false,
        latencyMs: 2_500,
        streams: 0,
        error: error instanceof Error ? error.message : "Request failed"
      });
      return [];
    }
  };

  const settledResults: any[][] = [];
  let resolveFirstUseful: (() => void) | undefined;
  const firstUseful = new Promise<void>((resolve) => {
    resolveFirstUseful = resolve;
  });
  const tasks = addons.map(async (addon: any, index: number) => {
    const result = await loadAddon(addon);
    try {
      return result;
    } finally {
      settledResults[index] = result;
      if (result.length) resolveFirstUseful?.();
    }
  });

  if (!tasks.length) return [];

  // Once one provider has usable streams, allow other fast providers a small
  // merge window. Slow/offline providers continue in the background so their
  // cache and health data can recover without delaying Stremio.
  await Promise.race([
    Promise.all(tasks),
    firstUseful.then(() => new Promise((resolve) => setTimeout(resolve, 300)))
  ]);

  return settledResults.flat();
}
