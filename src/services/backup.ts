import fs from "node:fs";
import path from "node:path";

import { APP_VERSION } from "../version";

const dataRoot = path.join(process.cwd(), "data");
const backupFiles = ["addons.json", "settings.json", "health.json", "cache.json"];
const restorableFiles = [...backupFiles, "profiles.json"];

function withoutSecrets(value: any): any {
  if (Array.isArray(value)) return value.map(withoutSecrets);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !["apiKey", "password", "token"].includes(key))
      .map(([key, item]) => [key, withoutSecrets(item)])
  );
}

export function createBackup() {
  const files: Record<string, unknown> = {};
  for (const filename of backupFiles) {
    const filePath = path.join(dataRoot, filename);
    if (!fs.existsSync(filePath)) continue;
    files[filename] = withoutSecrets(JSON.parse(fs.readFileSync(filePath, "utf8")));
  }
  return {
    format: "autostream-backup",
    version: 1,
    appVersion: APP_VERSION,
    createdAt: new Date().toISOString(),
    files
  };
}

export function restoreBackup(backup: any) {
  if (backup?.format !== "autostream-backup" || backup?.version !== 1) {
    throw new Error("Unsupported AutoStream backup");
  }
  if (!backup.files || typeof backup.files !== "object") {
    throw new Error("Backup has no data files");
  }
  const restored: string[] = [];
  for (const filename of restorableFiles) {
    if (!(filename in backup.files)) continue;
    let restoredValue = backup.files[filename];
    const currentPath = path.join(dataRoot, filename);
    if (fs.existsSync(currentPath) && filename === "settings.json") {
      const current = JSON.parse(fs.readFileSync(currentPath, "utf8"));
      restoredValue = {
        ...restoredValue,
        debrid: {
          ...(restoredValue.debrid || {}),
          apiKey: current.debrid?.apiKey || ""
        },
        jackett: {
          ...(restoredValue.jackett || {}),
          apiKey: current.jackett?.apiKey || ""
        }
      };
    }
    if (fs.existsSync(currentPath) && filename === "profiles.json" && Array.isArray(restoredValue)) {
      const current = JSON.parse(fs.readFileSync(currentPath, "utf8"));
      const currentById = new Map<string, any>(
        current.map((profile: any) => [String(profile.id), profile])
      );
      restoredValue = restoredValue.map((profile: any) => ({
        ...profile,
        settings: {
          ...(profile.settings || {}),
          debrid: {
            ...(profile.settings?.debrid || {}),
            apiKey: currentById.get(profile.id)?.settings?.debrid?.apiKey || ""
          },
          jackett: {
            ...(profile.settings?.jackett || {}),
            apiKey: currentById.get(profile.id)?.settings?.jackett?.apiKey || ""
          }
        }
      }));
    }
    fs.writeFileSync(
      path.join(dataRoot, filename),
      JSON.stringify(restoredValue, null, 2)
    );
    restored.push(filename);
  }
  return restored;
}
