import fs from "fs";
import path from "path";
import crypto from "node:crypto";
import { dataRoot, writeJsonAtomic } from "./storage";

const addonsFile = path.join(dataRoot, "addons.json");

export function isPlexAddon(addon: any) {
  return (
    addon?.sourceKind === "plex" ||
    String(addon?.id || "").toLowerCase() === "com.stremio.plexio"
  );
}

export function getAddons() {
  if (!fs.existsSync(addonsFile)) {
    return [];
  }

  const addons = JSON.parse(fs.readFileSync(addonsFile, "utf-8"));
  let changed = false;
  for (const addon of addons) {
    if (!addon.instanceId) {
      addon.instanceId = crypto
        .createHash("sha256")
        .update(String(addon.manifestUrl || addon.url || addon.id))
        .digest("hex")
        .slice(0, 24);
      changed = true;
    }
    if (
      !addon.sourceKind &&
      String(addon.id || "").toLowerCase() === "com.stremio.plexio"
    ) {
      addon.sourceKind = "plex";
      changed = true;
    }
  }
  if (changed) saveAddons(addons);
  return addons;
}

export function saveAddons(addons: any[]) {
  writeJsonAtomic(addonsFile, addons, 0o600);
}

export async function createAddon(url: string) {
  const manifestUrl = url.endsWith("/manifest.json")
    ? url
    : `${url.replace(/\/$/, "")}/manifest.json`;

  const baseUrl = manifestUrl.replace(/\/manifest\.json$/, "");

  const response = await fetch(manifestUrl, {
    signal: AbortSignal.timeout(10_000)
  });

  if (!response.ok) {
    throw new Error("Could not fetch addon manifest");
  }

  const manifest: any = await response.json();

  return {
    instanceId: crypto.randomUUID(),
    id: manifest.id || baseUrl,
    name: manifest.name || "Unknown Addon",
    version: manifest.version || "Unknown",
    description: manifest.description || "",
    logo: manifest.logo || "",
    url: baseUrl,
    manifestUrl,
    enabled: true,
    ...(String(manifest.id || "").toLowerCase() === "com.stremio.plexio"
      ? { sourceKind: "plex" }
      : {})
  };
}
