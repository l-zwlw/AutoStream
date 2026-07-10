import fs from "fs";
import path from "path";

const settingsFile = path.join(process.cwd(), "data/settings.json");

const defaultSettings = {
  profile: "balanced",
  fallback: {
    enabled: true,
    candidateTimeoutSeconds: 15,
    maximumCandidates: 5,
    minimumDownloadedKb: 256
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

function normalizeSettings(settings: any) {
  return {
    ...defaultSettings,
    ...settings,
    fallback: {
      enabled: settings.fallback?.enabled !== false,
      candidateTimeoutSeconds: clamp(
        settings.fallback?.candidateTimeoutSeconds,
        5,
        60,
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
