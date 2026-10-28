import { getAddons, isPlexAddon } from "../services/addons";
import { recordAddonResult, shouldTemporarilySkipAddon } from "../services/health";

const streamCache = new Map<string, { streams: any[]; expiresAt: number }>();
const cacheLifetimeMs = 10 * 60 * 1000;

function decorateStreams(addon: any, streams: any[]) {
  return streams.map((stream: any) => ({
    ...stream,
    _autostreamAddonId: addon.instanceId,
    _autostreamAddonName: addon.name,
    ...(isPlexAddon(addon) ? { _autostreamSourceKind: "plex" } : {})
  }));
}

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
      (
        isPlexAddon(addon) ||
        !selectionConfigured ||
        allowedAddonIds?.includes(addon.instanceId)
      )
  );
  // Never suppress the viewer's only source because of one temporary failure.
  const addons = enabledAddons.filter(
    (addon: any) => enabledAddons.length === 1 || !shouldTemporarilySkipAddon(addon.id)
  );
  const loadAddon = async (addon: any) => {
    const cacheKey = `${addon.instanceId}:${type}:${id}`;
    const cached = streamCache.get(cacheKey);
    const url = `${addon.url}/stream/${type}/${id}.json`;

    // Stremio commonly requests the same exact resource several times while
    // opening a detail page or starting playback. Return the still-fresh
    // source list immediately and refresh it in the background. A new title
    // still performs a live request, so this does not weaken verification.
    if (cached && cached.expiresAt > Date.now()) {
      void (async () => {
        const startedAt = Date.now();
        try {
          const refreshed = await fetchAddonStreams(url);
          streamCache.set(cacheKey, {
            streams: refreshed,
            expiresAt: Date.now() + cacheLifetimeMs
          });
          recordAddonResult(addon.instanceId, {
            success: true,
            latencyMs: Date.now() - startedAt,
            streams: refreshed.length
          });
        } catch (error) {
          recordAddonResult(addon.instanceId, {
            success: false,
            latencyMs: Date.now() - startedAt,
            streams: 0,
            error: error instanceof Error ? error.message : "Refresh failed"
          });
        }
      })();
      return decorateStreams(addon, cached.streams);
    }

    try {
      const startedAt = Date.now();

      // Configured addon URLs can contain API keys. Never write them to logs.
      console.log("Loading addon:", addon.name || addon.instanceId);

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
        return decorateStreams(addon, streams);
      }
      recordAddonResult(addon.instanceId, {
        success: true,
        latencyMs: Date.now() - startedAt,
        streams: 0
      });
      return [];
    } catch (error) {
      const cached = streamCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        console.warn("Addon failed; using cached streams:", addon.name || addon.url);
        return decorateStreams(addon, cached.streams);
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
  const plexTasks = tasks.filter((_: Promise<any[]>, index: number) =>
    isPlexAddon(addons[index])
  );
  await (plexTasks.length
    ? Promise.race([
        Promise.all(tasks),
        // Plex is the preferred source. Wait for it to answer (or hit its own
        // short timeout) before allowing a torrent result to leave the pool.
        Promise.all(plexTasks).then(
          () => new Promise((resolve) => setTimeout(resolve, 150))
        )
      ])
    : Promise.race([
        Promise.all(tasks),
        // Give direct HTTP providers enough time to join a fast torrent provider.
        firstUseful.then(() => new Promise((resolve) => setTimeout(resolve, 900)))
      ]));

  return settledResults.flat();
}
