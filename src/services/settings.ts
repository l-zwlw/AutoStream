import fs from "fs";
import path from "path";

const dataRoot = process.env.AUTOSTREAM_DATA_PATH || path.join(process.cwd(), "data");
const settingsFile = path.join(dataRoot, "settings.json");
const legacyProfilesFile = path.join(dataRoot, "profiles.json");
const archivedProfilesFile = path.join(dataRoot, "profiles.legacy.json");

function ensureDataRoot() {
  fs.mkdirSync(dataRoot, { recursive: true });
}

const defaultSettings = {
  playbackMethod: "torrent",
  addonIds: [] as string[],
  addonSelectionConfigured: false,
  addonPriorities: {} as Record<string, number>,
  device: {
    supports4k: true,
    supportsHdr: true,
    supportsDolbyVision: true,
    supportsHevc: true,
    supportsAv1: true
  },
  rules: {
    minimumQuality: "720p",
    maximumQuality: "4k",
    maximumSizeGb: 0,
    minimumSeeders: 0,
    preferredLanguage: "",
    allowedAudioLanguages: ["english"] as string[],
    allowRemux: true,
    preferHdr: false,
    preferredCodec: "automatic"
  },
  fallback: {
    enabled: true,
    candidateTimeoutSeconds: 20,
    maximumCandidates: 10,
    minimumDownloadedKb: 1024
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
  },
  jackett: {
    enabled: false,
    url: "",
    apiKey: "",
    indexer: "all"
  }
};

function clamp(value: unknown, minimum: number, maximum: number, fallback: number) {
  const number = Number(value);

  if (!Number.isFinite(number)) return fallback;

  return Math.min(Math.max(Math.round(number), minimum), maximum);
}

function httpUrl(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const url = new URL(value.trim());
    return ["http:", "https:"].includes(url.protocol)
      ? url.toString().replace(/\/$/, "")
      : "";
  } catch {
    return "";
  }
}

export function normalizeSettings(settings: any) {
  const { profile: _legacyStreamPreset, ...currentSettings } = settings || {};
  const { preset: _legacyDevicePreset, ...deviceSettings } = currentSettings.device || {};
  return {
    ...defaultSettings,
    ...currentSettings,
    playbackMethod: currentSettings.playbackMethod === "http" ? "http" : "torrent",
    addonIds: Array.isArray(currentSettings.addonIds)
      ? currentSettings.addonIds.filter((value: unknown) => typeof value === "string")
      : [],
    addonSelectionConfigured: currentSettings.addonSelectionConfigured === true,
    addonPriorities:
      currentSettings.addonPriorities && typeof currentSettings.addonPriorities === "object"
        ? currentSettings.addonPriorities
        : {},
    device: {
      ...defaultSettings.device,
      ...deviceSettings
    },
    rules: {
      ...defaultSettings.rules,
      ...(currentSettings.rules || {}),
      allowedAudioLanguages: Array.isArray(currentSettings.rules?.allowedAudioLanguages)
        ? currentSettings.rules.allowedAudioLanguages
            .filter((value: unknown) => typeof value === "string")
            .map((value: string) => value.trim().toLowerCase())
            .filter(Boolean)
        : currentSettings.rules?.preferredLanguage
          ? [String(currentSettings.rules.preferredLanguage).trim().toLowerCase()]
          : defaultSettings.rules.allowedAudioLanguages,
      maximumSizeGb: clamp(currentSettings.rules?.maximumSizeGb, 0, 500, 0),
      minimumSeeders: clamp(currentSettings.rules?.minimumSeeders, 0, 10000, 0)
    },
    fallback: {
      enabled: currentSettings.fallback?.enabled !== false,
      candidateTimeoutSeconds: clamp(
        currentSettings.fallback?.candidateTimeoutSeconds,
        20,
        30,
        defaultSettings.fallback.candidateTimeoutSeconds
      ),
      maximumCandidates: clamp(
        currentSettings.fallback?.maximumCandidates,
        10,
        20,
        defaultSettings.fallback.maximumCandidates
      ),
      minimumDownloadedKb: clamp(
        currentSettings.fallback?.minimumDownloadedKb,
        1024,
        4096,
        defaultSettings.fallback.minimumDownloadedKb
      )
    },
    midstream: {
      enabled: currentSettings.midstream?.enabled === true,
      prebufferMb: clamp(
        currentSettings.midstream?.prebufferMb,
        4,
        256,
        defaultSettings.midstream.prebufferMb
      ),
      stallTimeoutSeconds: clamp(
        currentSettings.midstream?.stallTimeoutSeconds,
        10,
        120,
        defaultSettings.midstream.stallTimeoutSeconds
      ),
      segmentSeconds: clamp(
        currentSettings.midstream?.segmentSeconds,
        2,
        10,
        defaultSettings.midstream.segmentSeconds
      ),
      retentionHours: clamp(
        currentSettings.midstream?.retentionHours,
        1,
        72,
        defaultSettings.midstream.retentionHours
      )
    },
    debrid: {
      ...defaultSettings.debrid,
      ...(currentSettings.debrid || {})
    },
    jackett: {
      ...defaultSettings.jackett,
      ...(currentSettings.jackett || {}),
      enabled: currentSettings.jackett?.enabled === true,
      url: httpUrl(currentSettings.jackett?.url)
    }
  };
}

function migrateLegacyProfileSettings() {
  if (!fs.existsSync(legacyProfilesFile)) return;

  try {
    const profiles = JSON.parse(fs.readFileSync(legacyProfilesFile, "utf8"));
    if (!Array.isArray(profiles) || profiles.length === 0) {
      throw new Error("No legacy profiles found");
    }

    const selected = profiles.find((profile: any) => profile?.id === "default") || profiles[0];
    const current = fs.existsSync(settingsFile)
      ? JSON.parse(fs.readFileSync(settingsFile, "utf8"))
      : {};
    const legacy = selected?.settings || {};
    const migrated = normalizeSettings({
      ...current,
      ...legacy,
      device: { ...(current.device || {}), ...(legacy.device || {}) },
      rules: { ...(current.rules || {}), ...(legacy.rules || {}) },
      fallback: { ...(current.fallback || {}), ...(legacy.fallback || {}) },
      midstream: { ...(current.midstream || {}), ...(legacy.midstream || {}) },
      debrid: { ...(current.debrid || {}), ...(legacy.debrid || {}) },
      jackett: { ...(current.jackett || {}), ...(legacy.jackett || {}) }
    });

    fs.writeFileSync(settingsFile, JSON.stringify(migrated, null, 2));
    const archivePath = fs.existsSync(archivedProfilesFile)
      ? path.join(dataRoot, `profiles.legacy-${Date.now()}.json`)
      : archivedProfilesFile;
    fs.renameSync(legacyProfilesFile, archivePath);
    console.log(`Migrated legacy viewer profile “${selected?.name || "Default"}” to global settings.`);
  } catch (error) {
    console.error("Could not migrate legacy viewer profiles:", error);
  }
}

export function getSettings() {
  migrateLegacyProfileSettings();
  if (!fs.existsSync(settingsFile)) {
    saveSettings(defaultSettings);
    return defaultSettings;
  }

  const settings = JSON.parse(fs.readFileSync(settingsFile, "utf-8"));

  return normalizeSettings(settings);
}

export function saveSettings(settings: any) {
  ensureDataRoot();
  fs.writeFileSync(
    settingsFile,
    JSON.stringify(normalizeSettings(settings), null, 2)
  );
}
