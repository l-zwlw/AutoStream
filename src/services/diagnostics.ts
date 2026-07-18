import os from "node:os";

import { APP_VERSION, RELEASE_CHANNEL } from "../version";
import { getAddons } from "./addons";
import { getHealthData } from "./health";
import { getSettings } from "./settings";
import { getQBittorrentStatus } from "./qbittorrent";

export async function createDiagnosticReport() {
  const addons = getAddons();
  const settings = getSettings();
  return {
    generatedAt: new Date().toISOString(),
    app: { version: APP_VERSION, channel: RELEASE_CHANNEL },
    runtime: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      uptimeSeconds: Math.round(process.uptime()),
      memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      cpuCount: os.cpus().length
    },
    qbittorrent: await getQBittorrentStatus(),
    addons: addons.map((addon: any) => ({
      id: addon.instanceId,
      name: addon.name,
      version: addon.version,
      enabled: addon.enabled !== false
    })),
    settings: {
      playbackMethod: settings.playbackMethod,
      configuredAddonCount: settings.addonIds?.length || 0
    },
    health: getHealthData().addons
  };
}
