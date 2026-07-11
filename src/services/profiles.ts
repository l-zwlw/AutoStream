import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { getSettings, normalizeSettings } from "./settings";

const profilesFile = path.join(process.cwd(), "data/profiles.json");

export interface AutoStreamProfile {
  id: string;
  name: string;
  createdAt: string;
  settings: any;
}

function safeClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function createDefaultProfile(): AutoStreamProfile {
  return {
    id: "default",
    name: "Default",
    createdAt: new Date().toISOString(),
    settings: {
      ...safeClone(getSettings()),
      playbackMethod: "torrent",
      midstream: {
        ...safeClone(getSettings().midstream),
        enabled: false
      }
    }
  };
}

function normalizeProfile(profile: any): AutoStreamProfile {
  const settings = normalizeSettings({
    ...safeClone(getSettings()),
    ...(profile?.settings || {})
  });

  settings.playbackMethod =
    settings.playbackMethod === "http" ? "http" : "torrent";
  settings.midstream.enabled = settings.playbackMethod === "http";

  return {
    id: String(profile?.id || crypto.randomUUID()),
    name: String(profile?.name || "Profile").trim().slice(0, 40) || "Profile",
    createdAt: profile?.createdAt || new Date().toISOString(),
    settings
  };
}

export function getProfiles(): AutoStreamProfile[] {
  if (!fs.existsSync(profilesFile)) {
    const profiles = [createDefaultProfile()];
    saveProfiles(profiles);
    return profiles;
  }

  try {
    const profiles = JSON.parse(fs.readFileSync(profilesFile, "utf8"));
    if (!Array.isArray(profiles) || profiles.length === 0) {
      throw new Error("No profiles found");
    }
    return profiles.map(normalizeProfile);
  } catch (error) {
    console.error("Could not read profiles; restoring the default profile:", error);
    const profiles = [createDefaultProfile()];
    saveProfiles(profiles);
    return profiles;
  }
}

export function saveProfiles(profiles: AutoStreamProfile[]) {
  fs.writeFileSync(
    profilesFile,
    JSON.stringify(profiles.map(normalizeProfile), null, 2)
  );
}

export function getProfile(id: string) {
  return getProfiles().find((profile) => profile.id === id);
}

export function createProfile(name: string) {
  const profiles = getProfiles();
  const profile = normalizeProfile({
    id: crypto.randomUUID(),
    name,
    settings: {
      ...safeClone(profiles[0]?.settings || getSettings()),
      playbackMethod: "torrent",
      midstream: {
        ...(profiles[0]?.settings?.midstream || getSettings().midstream),
        enabled: false
      }
    }
  });
  profiles.push(profile);
  saveProfiles(profiles);
  return profile;
}

export function updateProfile(id: string, patch: any) {
  const profiles = getProfiles();
  const index = profiles.findIndex((profile) => profile.id === id);
  if (index < 0) return undefined;
  const current = profiles[index]!;

  profiles[index] = normalizeProfile({
    ...current,
    ...patch,
    id,
    settings: {
      ...current.settings,
      ...(patch.settings || {}),
      fallback: {
        ...current.settings.fallback,
        ...(patch.settings?.fallback || {})
      },
      midstream: {
        ...current.settings.midstream,
        ...(patch.settings?.midstream || {})
      },
      debrid: {
        ...current.settings.debrid,
        ...(patch.settings?.debrid || {})
      }
    }
  });
  saveProfiles(profiles);
  return profiles[index];
}

export function deleteProfile(id: string) {
  const profiles = getProfiles();
  if (profiles.length === 1) return false;
  const next = profiles.filter((profile) => profile.id !== id);
  if (next.length === profiles.length) return false;
  saveProfiles(next);
  return true;
}
