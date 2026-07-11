import { getAddons } from "../services/addons";
import { recordAddonResult, shouldTemporarilySkipAddon } from "../services/health";

export async function getAddonStreams(
  type: string,
  id: string,
  allowedAddonIds?: string[],
  selectionConfigured = false
) {
  const addons = getAddons().filter(
    (addon: any) =>
      addon.enabled !== false &&
      !shouldTemporarilySkipAddon(addon.id) &&
      (!selectionConfigured || allowedAddonIds?.includes(addon.instanceId))
  );
  const results = await Promise.all(
    addons.map(async (addon: any) => {
      try {
      const startedAt = Date.now();
      const url = `${addon.url}/stream/${type}/${id}.json`;

      console.log("Loading addon:", url);

      const response = await fetch(url, {
        signal: AbortSignal.timeout(8_000)
      });

      if (!response.ok) {
        recordAddonResult(addon.instanceId, {
          success: false,
          latencyMs: Date.now() - startedAt,
          streams: 0,
          error: `HTTP ${response.status}`
        });
        return [];
      }

      const data: any = await response.json();

      if (data.streams) {
        recordAddonResult(addon.instanceId, {
          success: true,
          latencyMs: Date.now() - startedAt,
          streams: data.streams.length
        });
        return data.streams.map((stream: any) => ({
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
      console.log("Addon failed:", addon.name || addon.url);
      recordAddonResult(addon.instanceId, {
        success: false,
        latencyMs: 8_000,
        streams: 0,
        error: error instanceof Error ? error.message : "Request failed"
      });
      return [];
    }
    })
  );

  return results.flat();
}
