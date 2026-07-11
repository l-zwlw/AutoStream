import fs from "node:fs";
import path from "node:path";

const file = path.join(process.cwd(), "data/cache.json");

export function getCacheSettings() {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      maximumGb: Math.min(1000, Math.max(1, Number(value.maximumGb) || 50)),
      maximumConcurrentTranscodes: Math.min(8, Math.max(1, Number(value.maximumConcurrentTranscodes) || 2))
    };
  } catch {
    return { maximumGb: 50, maximumConcurrentTranscodes: 2 };
  }
}

export function saveCacheSettings(settings: any) {
  const value = {
    maximumGb: Math.min(1000, Math.max(1, Number(settings?.maximumGb) || 50)),
    maximumConcurrentTranscodes: Math.min(8, Math.max(1, Number(settings?.maximumConcurrentTranscodes) || 2))
  };
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
  return value;
}
