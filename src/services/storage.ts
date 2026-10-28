import fs from "node:fs";
import path from "node:path";

export const dataRoot =
  process.env.AUTOSTREAM_DATA_PATH || path.join(process.cwd(), "data");

const legacyDataRoot =
  process.env.AUTOSTREAM_LEGACY_DATA_PATH || "/legacy-data";

const persistentFiles = [
  "addons.json",
  "settings.json",
  "auth.json",
  "health.json",
  "cache.json",
  "profiles.json"
];
const privateFiles = new Set(["addons.json", "settings.json", "auth.json"]);

export function ensureDataRoot() {
  fs.mkdirSync(dataRoot, { recursive: true });
}

export function migrateLegacyData() {
  ensureDataRoot();
  if (!fs.existsSync(legacyDataRoot)) return [];

  const migrated: string[] = [];
  for (const filename of persistentFiles) {
    const source = path.join(legacyDataRoot, filename);
    const destination = path.join(dataRoot, filename);
    if (!fs.existsSync(source) || fs.existsSync(destination)) continue;
    fs.copyFileSync(source, destination);
    if (privateFiles.has(filename)) fs.chmodSync(destination, 0o600);
    migrated.push(filename);
  }
  if (migrated.length) {
    console.log(`Migrated persistent AutoStream data: ${migrated.join(", ")}`);
  }
  return migrated;
}

export function writeJsonAtomic(filePath: string, value: unknown, mode?: number) {
  ensureDataRoot();
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), {
    ...(mode ? { mode } : {})
  });
  fs.renameSync(temporary, filePath);
  if (mode) fs.chmodSync(filePath, mode);
}
