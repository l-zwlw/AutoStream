import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import {
  engineStreamUrl,
  prepareEngineTorrent,
  type EngineCandidate,
  type EngineTorrent
} from "./streamEngine";
import { getCacheSettings } from "./cacheSettings";

type VodSettings = {
  segmentSeconds?: number;
  retentionHours?: number;
};

type VodAsset = {
  key: string;
  candidates: EngineCandidate[];
  candidateIndex: number;
  active?: EngineTorrent;
  duration?: number;
  directory: string;
  preparing?: Promise<void>;
  generating: Map<number, Promise<string>>;
  lastAccessAt: number;
  retentionMs: number;
  segmentSeconds: number;
  failures: number;
  prefetching: boolean;
};

type VodSession = {
  id: string;
  assetKey: string;
  createdAt: number;
  lastAccessAt: number;
};

const downloadsRoot = process.env.DOWNLOADS_PATH || path.join(process.cwd(), "downloads");
const vodRoot = path.join(downloadsRoot, "vod");
const assets = new Map<string, VodAsset>();
const sessions = new Map<string, VodSession>();
let activeTranscodes = 0;
const transcodeQueue: Array<() => void> = [];

function startQueuedTranscodes() {
  const limit = getCacheSettings().maximumConcurrentTranscodes;
  while (activeTranscodes < limit && transcodeQueue.length > 0) {
    activeTranscodes += 1;
    transcodeQueue.shift()?.();
  }
}

async function withTranscodeSlot<T>(operation: () => Promise<T>) {
  const limit = getCacheSettings().maximumConcurrentTranscodes;
  if (activeTranscodes < limit) {
    activeTranscodes += 1;
  } else {
    await new Promise<void>((resolve) => transcodeQueue.push(resolve));
  }
  try {
    return await operation();
  } finally {
    activeTranscodes -= 1;
    startQueuedTranscodes();
  }
}

function clamp(value: unknown, min: number, max: number, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
}

function run(command: string, args: string[], timeoutMs: number) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const process = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      process.kill("SIGKILL");
      reject(new Error(`${command} timed out`));
    }, timeoutMs);
    process.stdout.on("data", (data) => stdout += data.toString());
    process.stderr.on("data", (data) => stderr = `${stderr}${data}`.slice(-12_000));
    process.once("error", reject);
    process.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited with ${code}: ${stderr.slice(-1000)}`));
    });
  });
}

function enforceSegmentCacheLimit() {
  if (!fs.existsSync(vodRoot)) return;
  const maximumBytes = getCacheSettings().maximumGb * 1024 * 1024 * 1024;
  const files = fs.readdirSync(vodRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => {
      const filePath = path.join(entry.parentPath, entry.name);
      const stats = fs.statSync(filePath);
      return { filePath, size: stats.size, mtimeMs: stats.mtimeMs };
    });
  let total = files.reduce((sum, file) => sum + file.size, 0);
  for (const file of files.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    if (total <= maximumBytes) break;
    fs.rmSync(file.filePath, { force: true });
    total -= file.size;
  }
}

async function prepareAsset(asset: VodAsset) {
  let lastError: unknown;
  if (!asset.duration && !asset.active && asset.candidateIndex === 0) {
    const initialCandidates = asset.candidates.slice(0, 3);
    const attempts = initialCandidates.map(async (candidate, index) => {
      try {
        const torrent = await prepareEngineTorrent(candidate);
        const probe = await run("ffprobe", [
          "-v", "error",
          "-show_entries", "format=duration",
          "-of", "default=noprint_wrappers=1:nokey=1",
          engineStreamUrl(torrent)
        ], 15_000);
        const duration = Number(probe.stdout.trim());
        if (!Number.isFinite(duration) || duration <= 0) {
          throw new Error("Could not determine video duration");
        }
        return { index, torrent, duration };
      } catch (error) {
        asset.failures += 1;
        throw error;
      }
    });

    try {
      const winner = await Promise.any(attempts);
      asset.candidateIndex = winner.index;
      asset.active = winner.torrent;
      asset.duration = winner.duration;
      return;
    } catch (error) {
      lastError = error;
      asset.candidateIndex = initialCandidates.length;
    }
  }

  while (asset.candidateIndex < asset.candidates.length) {
    try {
      const torrent = await prepareEngineTorrent(asset.candidates[asset.candidateIndex]!);
      const probe = await run("ffprobe", [
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        engineStreamUrl(torrent)
      ], 15_000);
      const duration = Number(probe.stdout.trim());
      if (!Number.isFinite(duration) || duration <= 0) {
        throw new Error("Could not determine video duration");
      }
      asset.active = torrent;
      asset.duration ??= duration;
      return;
    } catch (error) {
      lastError = error;
      asset.candidateIndex += 1;
      asset.failures += 1;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("No HTTP candidate could be prepared");
}

function ensureAsset(asset: VodAsset) {
  if (asset.active && asset.duration) return Promise.resolve();
  if (!asset.preparing) {
    asset.preparing = prepareAsset(asset).finally(() => { delete asset.preparing; });
  }
  return asset.preparing;
}

export function createVodSession(
  contentKey: string,
  candidates: EngineCandidate[],
  settings: VodSettings
) {
  fs.mkdirSync(vodRoot, { recursive: true });
  const segmentSeconds = clamp(settings.segmentSeconds, 2, 10, 4);
  const candidateSignature = candidates
    .slice(0, 5)
    .map((candidate) => `${candidate.infoHash || ""}:${candidate.fileIdx ?? ""}`)
    .join("|");
  const key = crypto.createHash("sha256")
    .update(`${contentKey}:${segmentSeconds}:${candidateSignature}`)
    .digest("hex");
  let asset = assets.get(key);
  if (!asset) {
    const directory = path.join(vodRoot, key);
    fs.mkdirSync(directory, { recursive: true });
    asset = {
      key,
      candidates: candidates.filter((candidate) => /^[a-fA-F0-9]{40}$/.test(candidate.infoHash || "")).slice(0, 5),
      candidateIndex: 0,
      directory,
      generating: new Map(),
      lastAccessAt: Date.now(),
      retentionMs: clamp(settings.retentionHours, 1, 72, 12) * 60 * 60 * 1000,
      segmentSeconds,
      failures: 0,
      prefetching: false
    };
    assets.set(key, asset);
  }
  const id = crypto.randomUUID();
  sessions.set(id, { id, assetKey: key, createdAt: Date.now(), lastAccessAt: Date.now() });
  void ensureAsset(asset).catch((error) => console.warn("VOD prepare failed:", error));
  return { id };
}

function getAsset(sessionId: string) {
  const session = sessions.get(sessionId);
  if (!session) return undefined;
  session.lastAccessAt = Date.now();
  const asset = assets.get(session.assetKey);
  if (asset) asset.lastAccessAt = Date.now();
  return asset;
}

export async function getVodPlaylist(sessionId: string) {
  const asset = getAsset(sessionId);
  if (!asset) return undefined;
  await ensureAsset(asset);
  const duration = asset.duration!;
  const count = Math.ceil(duration / asset.segmentSeconds);
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    `#EXT-X-TARGETDURATION:${asset.segmentSeconds}`,
    "#EXT-X-PLAYLIST-TYPE:VOD",
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-INDEPENDENT-SEGMENTS"
  ];
  for (let index = 0; index < count; index += 1) {
    const length = Math.min(asset.segmentSeconds, duration - index * asset.segmentSeconds);
    lines.push(`#EXTINF:${length.toFixed(3)},`, `segment-${index}.ts`);
  }
  lines.push("#EXT-X-ENDLIST");
  return lines.join("\n") + "\n";
}

async function generateSegment(asset: VodAsset, index: number) {
  await ensureAsset(asset);
  const count = Math.ceil(asset.duration! / asset.segmentSeconds);
  if (!Number.isInteger(index) || index < 0 || index >= count) {
    throw new Error("Segment is outside the video timeline");
  }
  const output = path.join(asset.directory, `segment-${index}.ts`);
  if (fs.existsSync(output) && fs.statSync(output).size > 0) return output;
  const temporary = `${output}.${crypto.randomUUID()}.tmp`;
  const start = index * asset.segmentSeconds;
  const length = Math.min(asset.segmentSeconds, asset.duration! - start);

  let lastError: unknown;
  for (let attempt = asset.candidateIndex; attempt < asset.candidates.length; attempt += 1) {
    try {
      if (!asset.active || attempt !== asset.candidateIndex) {
        asset.candidateIndex = attempt;
        delete asset.active;
        await ensureAsset(asset);
      }
      await withTranscodeSlot(() => run("ffmpeg", [
        "-hide_banner", "-loglevel", "error",
        "-ss", String(start),
        "-i", engineStreamUrl(asset.active!),
        "-t", String(length),
        "-map", "0:v:0", "-map", "0:a:0?",
        "-vf", "scale='min(1920,iw)':-2:force_original_aspect_ratio=decrease,format=yuv420p",
        "-c:v", "libx264", "-preset", "veryfast", "-profile:v", "high", "-level", "4.1",
        "-g", String(Math.max(24, asset.segmentSeconds * 30)), "-sc_threshold", "0",
        "-c:a", "aac", "-b:a", "160k", "-ac", "2",
        "-output_ts_offset", String(start),
        "-muxdelay", "0", "-muxpreload", "0",
        "-f", "mpegts", temporary
      ], 60_000));
      fs.renameSync(temporary, output);
      enforceSegmentCacheLimit();
      return output;
    } catch (error) {
      lastError = error;
      fs.rmSync(temporary, { force: true });
      asset.failures += 1;
      delete asset.active;
      asset.candidateIndex = attempt + 1;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Every segment candidate failed");
}

export function getVodSegment(sessionId: string, index: number) {
  const asset = getAsset(sessionId);
  if (!asset) return undefined;
  let task = asset.generating.get(index);
  if (!task) {
    task = generateSegment(asset, index)
      .then((segmentPath) => {
        if (!asset.prefetching) {
          asset.prefetching = true;
          void (async () => {
            try {
              for (const nextIndex of [index + 1, index + 2]) {
                const cachedPath = path.join(asset.directory, `segment-${nextIndex}.ts`);
                if (fs.existsSync(cachedPath)) continue;
                const existing = asset.generating.get(nextIndex);
                if (existing) await existing;
                else {
                  const prefetch = generateSegment(asset, nextIndex)
                    .finally(() => asset.generating.delete(nextIndex));
                  asset.generating.set(nextIndex, prefetch);
                  await prefetch;
                }
              }
            } catch (error) {
              console.warn("VOD prefetch failed:", error);
            } finally {
              asset.prefetching = false;
            }
          })();
        }
        return segmentPath;
      })
      .finally(() => asset.generating.delete(index));
    asset.generating.set(index, task);
  }
  return task;
}

export function getVodStatus() {
  return {
    sessions: sessions.size,
    activeTranscodes,
    queuedTranscodes: transcodeQueue.length,
    assets: Array.from(assets.values()).map((asset) => ({
      key: asset.key,
      ready: Boolean(asset.active && asset.duration),
      activeEngineId: asset.active?.id || null,
      activeInfoHash: asset.active?.infoHash || null,
      duration: asset.duration || null,
      candidate: asset.candidateIndex + 1,
      candidates: asset.candidates.length,
      cachedSegments: fs.existsSync(asset.directory)
        ? fs.readdirSync(asset.directory).filter((name) => name.endsWith(".ts")).length
        : 0,
      failures: asset.failures
    }))
  };
}

export function clearVodCache() {
  const removedAssets = assets.size;
  assets.clear();
  sessions.clear();
  fs.rmSync(vodRoot, { recursive: true, force: true });
  fs.mkdirSync(vodRoot, { recursive: true });
  return removedAssets;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastAccessAt > 12 * 60 * 60 * 1000) sessions.delete(id);
  }
  for (const [key, asset] of assets) {
    if (now - asset.lastAccessAt > asset.retentionMs) {
      assets.delete(key);
      fs.rmSync(asset.directory, { recursive: true, force: true });
    }
  }
}, 15 * 60 * 1000).unref();
