import fs from "node:fs";
import path from "node:path";

const healthFile = path.join(process.cwd(), "data/health.json");

export type AddonHealth = {
  addonId: string;
  requests: number;
  successes: number;
  failures: number;
  totalLatencyMs: number;
  streamsReturned: number;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
};

type ReliabilityData = {
  addons: Record<string, AddonHealth>;
  streams: Record<string, { successes: number; failures: number; lastUsedAt: string }>;
};

const emptyData = (): ReliabilityData => ({ addons: {}, streams: {} });

function readData(): ReliabilityData {
  if (!fs.existsSync(healthFile)) return emptyData();
  try {
    const value = JSON.parse(fs.readFileSync(healthFile, "utf8"));
    return { addons: value.addons || {}, streams: value.streams || {} };
  } catch {
    return emptyData();
  }
}

function writeData(data: ReliabilityData) {
  fs.writeFileSync(healthFile, JSON.stringify(data, null, 2));
}

function defaultAddon(addonId: string): AddonHealth {
  return {
    addonId,
    requests: 0,
    successes: 0,
    failures: 0,
    totalLatencyMs: 0,
    streamsReturned: 0,
    lastCheckedAt: null,
    lastSuccessAt: null,
    lastError: null
  };
}

export function recordAddonResult(
  addonId: string,
  result: { success: boolean; latencyMs: number; streams: number; error?: string }
) {
  const data = readData();
  const health = data.addons[addonId] || defaultAddon(addonId);
  health.requests += 1;
  health.totalLatencyMs += Math.max(0, result.latencyMs);
  health.streamsReturned += Math.max(0, result.streams);
  health.lastCheckedAt = new Date().toISOString();
  if (result.success) {
    health.successes += 1;
    health.lastSuccessAt = health.lastCheckedAt;
    health.lastError = null;
  } else {
    health.failures += 1;
    health.lastError = result.error || "Request failed";
  }
  data.addons[addonId] = health;
  writeData(data);
}

export function recordStreamOutcome(infoHash: string, success: boolean) {
  if (!/^[a-fA-F0-9]{40}$/.test(infoHash)) return;
  const data = readData();
  const key = infoHash.toLowerCase();
  const value = data.streams[key] || { successes: 0, failures: 0, lastUsedAt: "" };
  if (success) value.successes += 1;
  else value.failures += 1;
  value.lastUsedAt = new Date().toISOString();
  data.streams[key] = value;
  writeData(data);
}

export function getHealthData() {
  const data = readData();
  return {
    addons: Object.values(data.addons).map((health) => ({
      ...health,
      successRate: health.requests ? health.successes / health.requests : 0,
      averageLatencyMs: health.requests
        ? Math.round(health.totalLatencyMs / health.requests)
        : 0
    })),
    streams: data.streams
  };
}

export function getAddonReliability(addonId?: string) {
  if (!addonId) return 0.5;
  const health = readData().addons[addonId];
  if (!health || health.requests < 2) return 0.5;
  return (health.successes + 1) / (health.requests + 2);
}

export function shouldTemporarilySkipAddon(addonId: string) {
  const health = readData().addons[addonId];
  if (!health || health.failures < 3 || health.successes >= health.failures) return false;
  const lastChecked = health.lastCheckedAt ? Date.parse(health.lastCheckedAt) : 0;
  return lastChecked > Date.now() - 5 * 60 * 1000;
}

export function getStreamReliability(infoHash?: string) {
  if (!infoHash) return 0.5;
  const value = readData().streams[infoHash.toLowerCase()];
  if (!value) return 0.5;
  return (value.successes + 1) / (value.successes + value.failures + 2);
}

export function resetHealthData() {
  writeData(emptyData());
}
