import fs from "fs";
import path from "path";

const addonsFile = path.join(process.cwd(), "data/addons.json");

export function getAddons() {
  if (!fs.existsSync(addonsFile)) {
    return [];
  }

  return JSON.parse(fs.readFileSync(addonsFile, "utf-8"));
}

export function saveAddons(addons: any[]) {
  fs.writeFileSync(addonsFile, JSON.stringify(addons, null, 2));
}

export async function createAddon(url: string) {
  const manifestUrl = url.endsWith("/manifest.json")
    ? url
    : `${url.replace(/\/$/, "")}/manifest.json`;

  const baseUrl = manifestUrl.replace(/\/manifest\.json$/, "");

  const response = await fetch(manifestUrl);

  if (!response.ok) {
    throw new Error("Could not fetch addon manifest");
  }

  const manifest: any = await response.json();

  return {
    id: manifest.id || baseUrl,
    name: manifest.name || "Unknown Addon",
    version: manifest.version || "Unknown",
    description: manifest.description || "",
    logo: manifest.logo || "",
    url: baseUrl,
    manifestUrl,
    enabled: true
  };
}