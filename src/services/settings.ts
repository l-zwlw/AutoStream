import fs from "fs";
import path from "path";

const settingsFile = path.join(process.cwd(), "data/settings.json");

const defaultSettings = {
  playbackMethod: "torrent",
  profile: "balanced",
  fallback: {
    enabled: true,
    candidateTimeoutSeconds: 6,
    maximumCandidates: 3,
    minimumDownloadedKb: 256
  },
  midstream: {
    enabled: false,
    prebufferMb: 32,
    stallTimeoutSeconds: 30,
    segmentSeconds: 4,
    retentionHours: 12
  },
  debrid: {
    enabled: false,
    provider: "",
    apiKey: ""
  }
};

function clamp(value: unknown, minimum: number, maximum: number, fallback: number) {
  const number = Number(value);

  if (!Number.isFinite(number)) return fallback;

  return Math.min(Math.max(Math.round(number), minimum), maximum);
}

export function normalizeSettings(settings: any) {
  return {
    ...defaultSettings,
    ...settings,
    playbackMethod: settings.playbackMethod === "http" ? "http" : "torrent",
    fallback: {
      enabled: settings.fallback?.enabled !== false,
      candidateTimeoutSeconds: clamp(
        settings.fallback?.candidateTimeoutSeconds,
        3,
        8,
        defaultSettings.fallback.candidateTimeoutSeconds
      ),
      maximumCandidates: clamp(
        settings.fallback?.maximumCandidates,
        1,
        10,
        defaultSettings.fallback.maximumCandidates
      ),
      minimumDownloadedKb: clamp(
        settings.fallback?.minimumDownloadedKb,
        64,
        4096,
        defaultSettings.fallback.minimumDownloadedKb
      )
    },
    midstream: {
      enabled: settings.midstream?.enabled === true,
      prebufferMb: clamp(
        settings.midstream?.prebufferMb,
        4,
        256,
        defaultSettings.midstream.prebufferMb
      ),
      stallTimeoutSeconds: clamp(
        settings.midstream?.stallTimeoutSeconds,
        10,
        120,
        defaultSettings.midstream.stallTimeoutSeconds
      ),
      segmentSeconds: clamp(
        settings.midstream?.segmentSeconds,
        2,
        10,
        defaultSettings.midstream.segmentSeconds
      ),
      retentionHours: clamp(
        settings.midstream?.retentionHours,
        1,
        72,
        defaultSettings.midstream.retentionHours
      )
    },
    debrid: {
      ...defaultSettings.debrid,
      ...(settings.debrid || {})
    }
  };
}

export function getSettings() {
  if (!fs.existsSync(settingsFile)) {
    saveSettings(defaultSettings);
    return defaultSettings;
  }

  const settings = JSON.parse(fs.readFileSync(settingsFile, "utf-8"));

  return normalizeSettings(settings);
}

export function saveSettings(settings: any) {
  fs.writeFileSync(
    settingsFile,
    JSON.stringify(normalizeSettings(settings), null, 2)
  );
}
