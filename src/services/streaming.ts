import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import {
  deleteTorrent,
  getTorrent,
  getTorrentFiles,
  prepareStreamingCandidate,
  startTorrent,
  stopTorrent,
  type FallbackOptions,
  type PreparedTorrent,
  type TorrentCandidate
} from "./qbittorrent";

export type MidstreamSettings = {
  enabled?: boolean;
  prebufferMb?: number;
  stallTimeoutSeconds?: number;
  segmentSeconds?: number;
  retentionHours?: number;
};

type SessionState =
  | "preparing"
  | "streaming"
  | "switching"
  | "ended"
  | "failed";

type StreamingSession = {
  id: string;
  contentKey?: string;
  candidates: TorrentCandidate[];
  candidateIndex: number;
  state: SessionState;
  createdAt: number;
  lastAccessAt: number;
  retentionMs: number;
  outputDirectory: string;
  playlistPath: string;
  segmentSeconds: number;
  stallTimeoutMs: number;
  prebufferBytes: number;
  fallbackOptions: FallbackOptions;
  activeTorrent?: PreparedTorrent;
  standbyTorrent?: PreparedTorrent;
  standbyCandidateIndex?: number;
  standbyPromise?: Promise<void>;
  process?: ChildProcess;
  monitor?: NodeJS.Timeout;
  switching: boolean;
  lastSegmentCount: number;
  lastSegmentAt: number;
  lastError: string | null;
  switches: number;
  recentFfmpegOutput: string[];
  lastPersistedAt: number;
};

export type StreamingSessionView = {
  id: string;
  state: SessionState;
  candidate: number;
  candidates: number;
  switches: number;
  activeInfoHash: string | null;
  activeFile: string | null;
  standbyReady: boolean;
  segments: number;
  lastError: string | null;
  createdAt: number;
};

const sessions = new Map<string, StreamingSession>();
const contentSessions = new Map<string, string>();
const downloadsRoot =
  process.env.DOWNLOADS_PATH || path.join(process.cwd(), "downloads");
const hlsRoot = path.join(downloadsRoot, "hls");
const ffmpegBinary = process.env.FFMPEG_PATH || "ffmpeg";

function persistSession(session: StreamingSession) {
  const metadata = {
    version: 1,
    id: session.id,
    contentKey: session.contentKey,
    candidates: session.candidates,
    candidateIndex: session.candidateIndex,
    state: session.state,
    createdAt: session.createdAt,
    lastAccessAt: session.lastAccessAt,
    retentionMs: session.retentionMs,
    segmentSeconds: session.segmentSeconds,
    stallTimeoutMs: session.stallTimeoutMs,
    prebufferBytes: session.prebufferBytes,
    fallbackOptions: session.fallbackOptions,
    activeTorrent: session.activeTorrent,
    standbyTorrent: session.standbyTorrent,
    standbyCandidateIndex: session.standbyCandidateIndex,
    lastError: session.lastError,
    switches: session.switches
  };

  fs.writeFileSync(
    path.join(session.outputDirectory, "session.json"),
    JSON.stringify(metadata, null, 2)
  );
  session.lastPersistedAt = Date.now();
}

function clamp(value: unknown, minimum: number, maximum: number, fallback: number) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) return fallback;

  return Math.min(Math.max(Math.round(parsed), minimum), maximum);
}

function countSegments(playlistPath: string) {
  if (!fs.existsSync(playlistPath)) return 0;

  return (fs.readFileSync(playlistPath, "utf8").match(/^#EXTINF:/gm) || []).length;
}

function addEndList(playlistPath: string) {
  if (!fs.existsSync(playlistPath)) return;

  const playlist = fs.readFileSync(playlistPath, "utf8");

  if (!playlist.includes("#EXT-X-ENDLIST")) {
    fs.appendFileSync(playlistPath, "#EXT-X-ENDLIST\n");
  }
}

function sessionView(session: StreamingSession): StreamingSessionView {
  return {
    id: session.id,
    state: session.state,
    candidate: session.candidateIndex + 1,
    candidates: session.candidates.length,
    switches: session.switches,
    activeInfoHash: session.activeTorrent?.infoHash || null,
    activeFile: session.activeTorrent?.fileName || null,
    standbyReady: Boolean(session.standbyTorrent),
    segments: countSegments(session.playlistPath),
    lastError: session.lastError,
    createdAt: session.createdAt
  };
}

async function warmStandby(session: StreamingSession) {
  if (
    session.state !== "streaming" ||
    session.standbyTorrent ||
    session.standbyPromise
  ) {
    return;
  }

  const activeHash = session.activeTorrent?.infoHash;
  const nextIndex = session.candidates.findIndex(
    (candidate, index) =>
      index > session.candidateIndex &&
      candidate.infoHash?.toLowerCase() !== activeHash
  );

  if (nextIndex < 0) return;

  const candidate = session.candidates[nextIndex];
  if (!candidate) return;

  const promise = (async () => {
    try {
      const prepared = await prepareStreamingCandidate(
        candidate,
        session.fallbackOptions,
        session.prebufferBytes
      );

      await waitForFile(prepared.filePath);
      await stopTorrent(prepared.infoHash);
      session.standbyTorrent = prepared;
      session.standbyCandidateIndex = nextIndex;
      persistSession(session);
      console.log(
        `Mid-stream standby ready for ${session.id}: candidate ${nextIndex + 1}`
      );
    } catch (error) {
      console.warn(
        `Could not warm standby candidate ${nextIndex + 1}:`,
        error instanceof Error ? error.message : error
      );
    } finally {
      delete session.standbyPromise;
    }
  })();

  session.standbyPromise = promise;
  await promise;
}

async function waitForFile(filePath: string, timeoutMs = 10_000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (fs.existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Prepared video file is not available at ${filePath}`);
}

async function prepareCurrentCandidate(session: StreamingSession) {
  while (session.candidateIndex < session.candidates.length) {
    const candidate = session.candidates[session.candidateIndex];

    if (!candidate) break;

    try {
      const prepared = await prepareStreamingCandidate(
        candidate,
        session.fallbackOptions,
        session.prebufferBytes
      );

      await waitForFile(prepared.filePath);
      session.activeTorrent = prepared;
      session.lastError = null;
      persistSession(session);
      return;
    } catch (error) {
      session.lastError =
        error instanceof Error ? error.message : "Could not prepare candidate";
      console.warn(
        `Mid-stream candidate ${session.candidateIndex + 1} failed:`,
        session.lastError
      );
      session.candidateIndex += 1;
    }
  }

  throw new Error("No stream candidate could be prepared");
}

function rememberFfmpegOutput(session: StreamingSession, chunk: Buffer) {
  const lines = chunk
    .toString("utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  session.recentFfmpegOutput.push(...lines);
  session.recentFfmpegOutput = session.recentFfmpegOutput.slice(-20);
}

function startFfmpeg(session: StreamingSession) {
  const active = session.activeTorrent;

  if (!active) {
    throw new Error("No active torrent for FFmpeg");
  }

  const existingSegments = countSegments(session.playlistPath);
  const resumeSeconds = existingSegments * session.segmentSeconds;
  const segmentPattern = path.join(
    session.outputDirectory,
    `segment-${session.switches}-%09d.ts`
  );
  const hlsFlags = existingSegments > 0
    ? "append_list+omit_endlist+independent_segments+temp_file+discont_start"
    : "omit_endlist+independent_segments+temp_file";

  const args = [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-re",
    ...(resumeSeconds > 0 ? ["-ss", String(resumeSeconds)] : []),
    "-i",
    active.filePath,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "22",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-ac",
    "2",
    "-force_key_frames",
    `expr:gte(t,n_forced*${session.segmentSeconds})`,
    "-sc_threshold",
    "0",
    "-f",
    "hls",
    "-hls_time",
    String(session.segmentSeconds),
    "-hls_list_size",
    "0",
    "-start_number",
    String(existingSegments),
    "-hls_flags",
    hlsFlags,
    "-hls_segment_filename",
    segmentPattern,
    session.playlistPath
  ];

  const child = spawn(ffmpegBinary, args, {
    stdio: ["ignore", "pipe", "pipe"]
  });

  session.process = child;
  session.state = "streaming";
  session.lastSegmentCount = existingSegments;
  session.lastSegmentAt = Date.now();
  persistSession(session);

  child.stderr?.on("data", (chunk: Buffer) => {
    rememberFfmpegOutput(session, chunk);
  });

  child.on("error", (error) => {
    session.lastError = error.message;
    void switchCandidate(session, `FFmpeg error: ${error.message}`);
  });

  child.on("close", (code, signal) => {
    if (session.switching || session.state === "failed") return;

    delete session.process;

    if (code === 0) {
      session.state = "ended";
      addEndList(session.playlistPath);
      persistSession(session);
      return;
    }

    const detail = session.recentFfmpegOutput.at(-1) || `signal ${signal || "none"}`;
    void switchCandidate(session, `FFmpeg stopped (${code}): ${detail}`);
  });

  void warmStandby(session);
}

async function switchCandidate(session: StreamingSession, reason: string) {
  if (session.switching || session.state === "ended" || session.state === "failed") {
    return;
  }

  session.switching = true;
  session.state = "switching";
  session.lastError = reason;
  persistSession(session);
  console.warn(`Mid-stream fallback for ${session.id}: ${reason}`);

  if (session.process && !session.process.killed) {
    session.process.kill("SIGTERM");
  }

  const previousTorrent = session.activeTorrent;
  delete session.activeTorrent;

  if (previousTorrent?.createdByAutoStream) {
    await deleteTorrent(previousTorrent.infoHash).catch(() => undefined);
  }

  if (session.standbyPromise) {
    await session.standbyPromise.catch(() => undefined);
  }

  if (
    session.standbyTorrent &&
    typeof session.standbyCandidateIndex === "number"
  ) {
    session.activeTorrent = session.standbyTorrent;
    session.candidateIndex = session.standbyCandidateIndex;
    delete session.standbyTorrent;
    delete session.standbyCandidateIndex;
    await startTorrent(session.activeTorrent.infoHash);
  } else {
    session.candidateIndex += 1;
  }
  session.switches += 1;

  try {
    if (!session.activeTorrent) {
      await prepareCurrentCandidate(session);
    }
    session.switching = false;
    startFfmpeg(session);
  } catch (error) {
    session.switching = false;
    session.state = "failed";
    session.lastError = error instanceof Error ? error.message : "Fallback failed";
    addEndList(session.playlistPath);
    persistSession(session);
    console.error(`Mid-stream session ${session.id} failed:`, session.lastError);
  }
}

function startMonitor(session: StreamingSession) {
  session.monitor = setInterval(async () => {
    if (session.state !== "streaming" || session.switching) return;

    const segmentCount = countSegments(session.playlistPath);

    if (segmentCount > session.lastSegmentCount) {
      session.lastSegmentCount = segmentCount;
      session.lastSegmentAt = Date.now();
      return;
    }

    if (Date.now() - session.lastSegmentAt < session.stallTimeoutMs) return;

    const active = session.activeTorrent;

    if (!active) return;

    try {
      const [torrent, files] = await Promise.all([
        getTorrent(active.infoHash),
        getTorrentFiles(active.infoHash)
      ]);
      const file = files.find((item) => item.index === active.fileIndex);
      const progress = file ? Math.round(file.progress * 1000) / 10 : 0;
      const speed = torrent?.dlspeed || 0;

      await switchCandidate(
        session,
        `no new HLS segment for ${session.stallTimeoutMs / 1000}s ` +
          `(torrent ${progress}%, ${speed} B/s)`
      );
    } catch (error) {
      await switchCandidate(
        session,
        error instanceof Error ? error.message : "Could not inspect torrent"
      );
    }
  }, 3000);

  session.monitor.unref();
}

export async function createStreamingSession(
  rankedCandidates: TorrentCandidate[],
  fallbackOptions: FallbackOptions,
  midstreamSettings: MidstreamSettings,
  contentKey?: string
) {
  if (contentKey) {
    const existingId = contentSessions.get(contentKey);
    const existing = existingId ? sessions.get(existingId) : undefined;

    if (existing && existing.state !== "failed") {
      existing.lastAccessAt = Date.now();
      return sessionView(existing);
    }

    if (existingId) contentSessions.delete(contentKey);
  }

  const maximumCandidates = clamp(
    fallbackOptions.maximumCandidates,
    1,
    10,
    5
  );
  const candidates = rankedCandidates
    .filter(
      (candidate) =>
        typeof candidate.infoHash === "string" &&
        /^[a-fA-F0-9]{40}$/.test(candidate.infoHash)
    )
    .slice(0, maximumCandidates);

  if (!candidates.length) {
    throw new Error("No torrent candidates are available for HTTP streaming");
  }

  fs.mkdirSync(hlsRoot, { recursive: true });

  const id = crypto.randomUUID();
  const outputDirectory = path.join(hlsRoot, id);
  fs.mkdirSync(outputDirectory, { recursive: true });

  const session: StreamingSession = {
    id,
    ...(contentKey ? { contentKey } : {}),
    candidates,
    candidateIndex: 0,
    state: "preparing",
    createdAt: Date.now(),
    lastAccessAt: Date.now(),
    retentionMs:
      clamp(midstreamSettings.retentionHours, 1, 72, 12) * 60 * 60 * 1000,
    outputDirectory,
    playlistPath: path.join(outputDirectory, "index.m3u8"),
    segmentSeconds: clamp(midstreamSettings.segmentSeconds, 2, 10, 4),
    stallTimeoutMs:
      clamp(midstreamSettings.stallTimeoutSeconds, 10, 120, 30) * 1000,
    prebufferBytes:
      clamp(midstreamSettings.prebufferMb, 4, 256, 32) * 1024 * 1024,
    fallbackOptions,
    switching: false,
    lastSegmentCount: 0,
    lastSegmentAt: Date.now(),
    lastError: null,
    switches: 0,
    recentFfmpegOutput: [],
    lastPersistedAt: 0
  };

  sessions.set(id, session);
  if (contentKey) contentSessions.set(contentKey, id);
  persistSession(session);

  void (async () => {
    try {
      await prepareCurrentCandidate(session);
      startFfmpeg(session);
      startMonitor(session);
    } catch (error) {
      session.state = "failed";
      session.lastError = error instanceof Error ? error.message : "Session failed";
      persistSession(session);
    }
  })();

  return sessionView(session);
}

export function getStreamingSession(id: string) {
  const session = sessions.get(id);

  return session ? sessionView(session) : null;
}

export function touchStreamingSession(id: string) {
  const session = sessions.get(id);

  if (session) {
    session.lastAccessAt = Date.now();

    if (Date.now() - session.lastPersistedAt > 60_000) {
      persistSession(session);
    }
  }
}

export function getStreamingSessions() {
  return Array.from(sessions.values()).map(sessionView);
}

export function getStreamingPlaylistPath(id: string) {
  return sessions.get(id)?.playlistPath || null;
}

export function getStreamingSegmentPath(id: string, filename: string) {
  if (!/^segment-\d+-\d+\.ts$/.test(filename)) return null;

  const session = sessions.get(id);
  if (!session) return null;

  return path.join(session.outputDirectory, filename);
}

export async function waitForPlaylist(id: string, timeoutMs = 45_000) {
  const session = sessions.get(id);

  if (!session) return null;

  session.lastAccessAt = Date.now();

  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (fs.existsSync(session.playlistPath) && countSegments(session.playlistPath) > 0) {
      return session.playlistPath;
    }

    if (session.state === "failed") return null;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return null;
}

async function resumeRestoredSession(session: StreamingSession) {
  if (
    session.state === "ended" &&
    fs.existsSync(session.playlistPath) &&
    fs.readFileSync(session.playlistPath, "utf8").includes("#EXT-X-ENDLIST")
  ) {
    return;
  }

  session.state = "preparing";
  session.switching = false;

  try {
    if (session.activeTorrent) {
      let torrentAvailable = false;

      for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
          torrentAvailable = Boolean(
            await getTorrent(session.activeTorrent.infoHash)
          );
          if (torrentAvailable) break;
        } catch {
          // qBittorrent may still be starting after a Compose restart.
        }

        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      if (
        torrentAvailable &&
        fs.existsSync(session.activeTorrent.filePath)
      ) {
        await startTorrent(session.activeTorrent.infoHash);
      } else {
        delete session.activeTorrent;
      }
    }

    if (!session.activeTorrent) {
      await prepareCurrentCandidate(session);
    }

    startFfmpeg(session);
    startMonitor(session);
    console.log(`Restored mid-stream session ${session.id}`);
  } catch (error) {
    session.state = "failed";
    session.lastError =
      error instanceof Error ? error.message : "Could not restore session";
    persistSession(session);
    console.warn(`Could not restore mid-stream session ${session.id}:`, session.lastError);
  }
}

export function restoreStreamingSessions() {
  fs.mkdirSync(hlsRoot, { recursive: true });

  for (const directoryName of fs.readdirSync(hlsRoot)) {
    const outputDirectory = path.join(hlsRoot, directoryName);
    const metadataPath = path.join(outputDirectory, "session.json");

    if (!fs.existsSync(metadataPath)) continue;

    try {
      const stored = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as any;
      const lastAccessAt = Number(stored.lastAccessAt || stored.createdAt || 0);
      const retentionMs = Number(stored.retentionMs || 12 * 60 * 60 * 1000);

      if (!lastAccessAt || Date.now() - lastAccessAt > retentionMs) {
        fs.rmSync(outputDirectory, { recursive: true, force: true });
        continue;
      }

      const session: StreamingSession = {
        id: String(stored.id || directoryName),
        ...(stored.contentKey ? { contentKey: String(stored.contentKey) } : {}),
        candidates: Array.isArray(stored.candidates) ? stored.candidates : [],
        candidateIndex: Number(stored.candidateIndex || 0),
        state: stored.state === "ended" ? "ended" : "preparing",
        createdAt: Number(stored.createdAt || Date.now()),
        lastAccessAt,
        retentionMs,
        outputDirectory,
        playlistPath: path.join(outputDirectory, "index.m3u8"),
        segmentSeconds: Number(stored.segmentSeconds || 4),
        stallTimeoutMs: Number(stored.stallTimeoutMs || 30_000),
        prebufferBytes: Number(stored.prebufferBytes || 32 * 1024 * 1024),
        fallbackOptions: stored.fallbackOptions || {},
        ...(stored.activeTorrent ? { activeTorrent: stored.activeTorrent } : {}),
        ...(stored.standbyTorrent ? { standbyTorrent: stored.standbyTorrent } : {}),
        ...(typeof stored.standbyCandidateIndex === "number"
          ? { standbyCandidateIndex: stored.standbyCandidateIndex }
          : {}),
        switching: false,
        lastSegmentCount: countSegments(path.join(outputDirectory, "index.m3u8")),
        lastSegmentAt: Date.now(),
        lastError: stored.lastError || null,
        switches: Number(stored.switches || 0),
        recentFfmpegOutput: [],
        lastPersistedAt: Date.now()
      };

      sessions.set(session.id, session);
      if (session.contentKey) contentSessions.set(session.contentKey, session.id);
      void resumeRestoredSession(session);
    } catch (error) {
      console.warn(`Ignoring invalid streaming session ${directoryName}:`, error);
    }
  }
}


async function disposeSession(session: StreamingSession) {
  session.state = "failed";
  session.switching = true;

  if (session.process && !session.process.killed) {
    session.process.kill("SIGTERM");
  }

  if (session.monitor) clearInterval(session.monitor);

  const torrents = [session.activeTorrent, session.standbyTorrent].filter(
    (torrent): torrent is PreparedTorrent => Boolean(torrent)
  );

  await Promise.all(
    torrents.map((torrent) =>
      torrent.createdByAutoStream
        ? deleteTorrent(torrent.infoHash).catch(() => undefined)
        : Promise.resolve()
    )
  );

  sessions.delete(session.id);
  if (session.contentKey) contentSessions.delete(session.contentKey);
  fs.rmSync(session.outputDirectory, { recursive: true, force: true });
}

const cleanupTimer = setInterval(() => {
  const now = Date.now();

  for (const session of sessions.values()) {
    if (now - session.lastAccessAt > session.retentionMs) {
      void disposeSession(session);
    }
  }
}, 15 * 60 * 1000);

cleanupTimer.unref();
