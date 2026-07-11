import os from "node:os";

import { APP_VERSION, RELEASE_CHANNEL } from "../version";
import { getAddons } from "./addons";
import { getHealthData } from "./health";
import { getProfiles } from "./profiles";
import { getQBittorrentStatus } from "./qbittorrent";

export async function createDiagnosticReport() {
  const addons = getAddons();
  const profiles = getProfiles();
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
    profiles: profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      playbackMethod: profile.settings.playbackMethod,
      playbackProfile: profile.settings.profile,
      configuredAddonCount: profile.settings.addonIds?.length || 0
    })),
    health: getHealthData().addons
  };
}
