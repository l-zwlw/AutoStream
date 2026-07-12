import express from "express";
import cors from "cors";
import path from "node:path";
import crypto from "node:crypto";

import { manifest } from "./manifest";
import { getStreams } from "./streams";
import {
  getAddons,
  saveAddons,
  createAddon
} from "./services/addons";
import {
  getSettings,
  saveSettings
} from "./services/settings";
import { getQBittorrentStatus } from "./services/qbittorrent";
import {
  createVodSession,
  getVodPlaylist,
  getVodSegment,
  getVodStatus,
  clearVodCache
} from "./services/vodStreaming";
import { clearEngineTorrents, getStreamEngineStatus } from "./services/streamEngine";
import { APP_VERSION, RELEASE_CHANNEL } from "./version";
import fs from "node:fs";
import {
  createProfile,
  deleteProfile,
  getProfile,
  getProfiles,
  updateProfile
} from "./services/profiles";
import {
  clearFailedAttempts,
  createSession,
  destroySession,
  isPasswordConfigured,
  isValidSession,
  parseSessionCookie,
  registerFailedAttempt,
  retryAfterSeconds,
  sessionCookieMaxAgeSeconds,
  setPassword,
  verifyPassword
} from "./services/auth";
import { createBackup, restoreBackup } from "./services/backup";
import { getCacheSettings, saveCacheSettings } from "./services/cacheSettings";
import { createDiagnosticReport } from "./services/diagnostics";
import { getHealthData, recordAddonResult, resetHealthData } from "./services/health";
import {
  clearAutoStreamTorrents,
  getAutoStreamTorrents
} from "./services/qbittorrent";
import { getJackettStatus } from "./providers/jackett";

const app = express();
const experimentalHttpEnabled =
  process.env.ENABLE_EXPERIMENTAL_HTTP === "true";

app.set("trust proxy", true);
app.use(cors());
app.use(express.json());
app.use(express.static("src/public", { index: false }));

function dashboardSession(req: express.Request) {
  return parseSessionCookie(req.headers.cookie);
}

function setSessionCookie(req: express.Request, res: express.Response, token: string) {
  res.cookie("autostream_session", token, {
    httpOnly: true,
    sameSite: "strict",
    secure: req.secure,
    path: "/",
    maxAge: sessionCookieMaxAgeSeconds * 1000
  });
}

app.get("/login", (req, res) => {
  if (isValidSession(dashboardSession(req))) return res.redirect("/");
  res.sendFile(path.join(process.cwd(), "src/public/login.html"));
});

app.get("/api/auth/status", (req, res) => {
  res.json({
    configured: isPasswordConfigured(),
    authenticated: isValidSession(dashboardSession(req))
  });
});

app.post("/api/auth/setup", (req, res) => {
  if (isPasswordConfigured()) {
    return res.status(409).json({ error: "Dashboard password is already configured" });
  }
  try {
    setPassword(String(req.body?.password || ""));
    const token = createSession();
    setSessionCookie(req, res, token);
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Could not set password"
    });
  }
});

app.post("/api/auth/login", (req, res) => {
  const client = req.ip || "unknown";
  const retryAfter = retryAfterSeconds(client);
  if (retryAfter > 0) {
    res.setHeader("Retry-After", retryAfter);
    return res.status(429).json({ error: `Try again in ${retryAfter} seconds` });
  }
  if (!verifyPassword(String(req.body?.password || ""))) {
    registerFailedAttempt(client);
    return res.status(401).json({ error: "Incorrect password" });
  }
  clearFailedAttempts(client);
  const token = createSession();
  setSessionCookie(req, res, token);
  res.json({ success: true });
});

app.post("/api/auth/logout", (req, res) => {
  destroySession(dashboardSession(req));
  res.clearCookie("autostream_session", { path: "/" });
  res.json({ success: true });
});

app.use("/api", (req, res, next) => {
  if (isValidSession(dashboardSession(req))) return next();
  res.status(401).json({ error: "Dashboard login required" });
});

app.get("/", (req, res) => {
  if (!isValidSession(dashboardSession(req))) return res.redirect("/login");
  res.sendFile(path.join(process.cwd(), "src/public/index.html"));
});

app.get("/configure", (req, res) => {
  res.redirect("/login?next=/profiles");
});

function manifestForRequest(req: express.Request, profile?: { id: string; name: string }) {
  const baseUrl = `${req.protocol}://${req.get("host")}`;
  return {
    ...manifest,
    ...(profile
      ? {
          id: `${manifest.id}.${profile.id}`,
          name: `${manifest.name} · ${profile.name}`,
          description: `${manifest.description} Profile: ${profile.name}.`
        }
      : {}),
    logo: `${baseUrl}/icon.png`,
    background: `${baseUrl}/logo.png`
  };
}

app.get("/manifest.json", (req, res) => {
  res.json(manifestForRequest(req));
});

app.get("/p/:profileId/manifest.json", (req, res) => {
  const profile = getProfile(req.params.profileId);
  if (!profile) return res.status(404).json({ error: "Profile not found" });

  res.json(manifestForRequest(req, profile));
});

app.get("/stream/:type/:id.json", async (req, res) => {
  try {
    const streams = await getStreams(
      req.params.type,
      req.params.id,
      `${req.protocol}://${req.get("host")}`
    );

    res.json({ streams });
  } catch (error) {
    console.error("Stream error:", error);
    res.status(500).json({ streams: [] });
  }
});

app.get("/p/:profileId/stream/:type/:id.json", async (req, res) => {
  const profile = getProfile(req.params.profileId);
  if (!profile) return res.status(404).json({ streams: [] });

  try {
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const streams = await getStreams(
      req.params.type,
      req.params.id,
      baseUrl,
      profile.settings
    );
    res.json({ streams });
  } catch (error) {
    console.error(`Stream error for profile ${profile.id}:`, error);
    res.status(500).json({ streams: [] });
  }
});

app.get("/api/status", async (req, res) => {
  const settings = getSettings();
  const qbittorrent = await getQBittorrentStatus();
  const profiles = getProfiles();
  const jackettSettings = profiles.find(
    (profile) => profile.settings.jackett?.enabled
  )?.settings.jackett || settings.jackett;

  res.json({
    status: "online",
    version: APP_VERSION,
    releaseChannel: RELEASE_CHANNEL,
    addons: getAddons().length,
    profile: settings.profile || "balanced",
    debridEnabled: settings.debrid?.enabled || false,
    fallbackEnabled:
      settings.fallback?.enabled !== false &&
      settings.profile !== "debrid",
    midstreamEnabled: profiles.some(
      (profile) =>
        profile.settings.playbackMethod === "http" &&
        profile.settings.profile !== "debrid"
    ),
    streamingSessions: getVodStatus().sessions,
    httpStreamingAvailable: experimentalHttpEnabled,
    streamEngine: await getStreamEngineStatus(),
    jackett: await getJackettStatus(jackettSettings),
    fallbackEngine: qbittorrent
  });
});

app.get("/api/qbittorrent/status", async (req, res) => {
  const status = await getQBittorrentStatus();

  res.status(status.online ? 200 : 503).json(status);
});

app.get("/api/health", (req, res) => {
  res.json(getHealthData());
});

app.post("/api/health/test", async (req, res) => {
  const results = await Promise.all(
    getAddons().map(async (addon: any) => {
      const startedAt = Date.now();
      try {
        const response = await fetch(addon.manifestUrl, {
          signal: AbortSignal.timeout(8_000)
        });
        const result = {
          addonId: addon.instanceId,
          name: addon.name,
          success: response.ok,
          latencyMs: Date.now() - startedAt,
          error: response.ok ? null : `HTTP ${response.status}`,
          manifest: response.ok ? await response.json().catch(() => null) : null
        };
        recordAddonResult(addon.instanceId, {
          success: result.success,
          latencyMs: result.latencyMs,
          streams: 0,
          ...(result.error ? { error: result.error } : {})
        });
        return result;
      } catch (error) {
        const result = {
          addonId: addon.instanceId,
          name: addon.name,
          success: false,
          latencyMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : "Request failed"
        };
        recordAddonResult(addon.instanceId, { ...result, streams: 0 });
        return result;
      }
    })
  );
  const addons = getAddons();
  for (const result of results) {
    const manifest = result.manifest as any;
    const addon = addons.find((item: any) => item.instanceId === result.addonId);
    if (addon && manifest) {
      addon.name = manifest.name || addon.name;
      addon.version = manifest.version || addon.version;
      addon.description = manifest.description || addon.description;
      addon.logo = manifest.logo || addon.logo;
    }
  }
  saveAddons(addons);
  res.json({
    results: results.map(({ manifest, ...result }) => result)
  });
});

app.delete("/api/health", (req, res) => {
  resetHealthData();
  res.json({ success: true });
});

function directorySize(directory: string): number {
  if (!fs.existsSync(directory)) return 0;
  return fs.readdirSync(directory, { withFileTypes: true }).reduce((total, entry) => {
    const entryPath = path.join(directory, entry.name);
    return total + (entry.isDirectory() ? directorySize(entryPath) : fs.statSync(entryPath).size);
  }, 0);
}

app.get("/api/cache", async (req, res) => {
  const downloadsPath = process.env.DOWNLOADS_PATH || path.join(process.cwd(), "downloads");
  try {
    res.json({
      sizeBytes: directorySize(downloadsPath),
      torrents: await getAutoStreamTorrents(),
      settings: getCacheSettings()
    });
  } catch (error) {
    res.status(503).json({
      sizeBytes: directorySize(downloadsPath),
      torrents: [],
      error: error instanceof Error ? error.message : "Cache unavailable"
    });
  }
});

app.patch("/api/cache", (req, res) => {
  res.json({ success: true, settings: saveCacheSettings(req.body) });
});

app.delete("/api/cache", async (req, res) => {
  try {
    const [removed, engine] = await Promise.all([
      clearAutoStreamTorrents(),
      clearEngineTorrents()
    ]);
    const vodAssets = clearVodCache();
    const downloadsPath = process.env.DOWNLOADS_PATH || path.join(process.cwd(), "downloads");
    for (const directory of ["autostream", "engine", "hls"]) {
      fs.rmSync(path.join(downloadsPath, directory), { recursive: true, force: true });
    }
    res.json({ success: true, removed, engineRemoved: engine.removed, vodAssets });
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : "Could not clear cache" });
  }
});

app.get("/api/backup", (req, res) => {
  res.setHeader("Content-Disposition", `attachment; filename=autostream-backup-${Date.now()}.json`);
  res.json(createBackup());
});

app.post("/api/backup/restore", (req, res) => {
  try {
    res.json({ success: true, restored: restoreBackup(req.body) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Restore failed" });
  }
});

app.get("/api/diagnostics", async (req, res) => {
  res.setHeader("Content-Disposition", `attachment; filename=autostream-diagnostics-${Date.now()}.json`);
  res.json(await createDiagnosticReport());
});

app.get("/api/profiles", (req, res) => {
  const baseUrl = `${req.protocol}://${req.get("host")}`;
  res.json(
    getProfiles().map((profile) => ({
      ...profile,
      installUrl: `${baseUrl}/p/${profile.id}/manifest.json`,
      settings: {
        ...profile.settings,
        debrid: {
          ...profile.settings.debrid,
          apiKey: profile.settings.debrid?.apiKey ? "********" : ""
        },
        jackett: {
          ...profile.settings.jackett,
          apiKey: profile.settings.jackett?.apiKey ? "********" : ""
        }
      }
    }))
  );
});

app.post("/api/profiles", (req, res) => {
  const profile = createProfile(req.body?.name);
  res.status(201).json({ success: true, profile });
});

app.patch("/api/profiles/:profileId", (req, res) => {
  const current = getProfile(req.params.profileId);
  if (!current) return res.status(404).json({ error: "Profile not found" });

  const patch = { ...req.body };
  if (
    patch.settings?.playbackMethod === "http" &&
    !experimentalHttpEnabled
  ) {
    return res.status(400).json({
      error: "HTTP streaming is not available in this release"
    });
  }
  if (patch.settings?.debrid?.apiKey === "********") {
    patch.settings.debrid.apiKey = current.settings.debrid?.apiKey || "";
  }
  if (patch.settings?.jackett?.apiKey === "********") {
    patch.settings.jackett.apiKey = current.settings.jackett?.apiKey || "";
  }
  const profile = updateProfile(req.params.profileId, patch);
  res.json({ success: true, profile });
});

app.delete("/api/profiles/:profileId", (req, res) => {
  if (!deleteProfile(req.params.profileId)) {
    return res.status(400).json({
      error: "Profile not found or the last profile cannot be deleted"
    });
  }
  res.json({ success: true });
});

app.get("/api/streaming/sessions", (req, res) => {
  res.json(getVodStatus());
});

app.get("/api/streaming/sessions/:id", (req, res) => {
  res.status(410).json({ error: "Legacy streaming session details are no longer available" });
});

app.post("/api/streaming/test", async (req, res) => {
  if (process.env.STREAMING_TEST_MODE !== "true") {
    return res.status(404).json({ error: "Not found" });
  }

  try {
    const session = createVodSession(
      `test:${crypto.randomUUID()}`,
      Array.isArray(req.body.candidates) ? req.body.candidates : [],
      req.body.settings || { segmentSeconds: 4, retentionHours: 1 }
    );
    res.json({
      ...session,
      url: `${req.protocol}://${req.get("host")}/play/${session.id}/index.m3u8`
    });
  } catch (error) {
    res.status(503).json({
      error: error instanceof Error ? error.message : "Test session failed"
    });
  }
});

app.get("/play/:sessionId/index.m3u8", async (req, res) => {
  try {
    const playlist = await getVodPlaylist(req.params.sessionId);
    if (!playlist) return res.status(404).json({ error: "VOD session not found" });
    res.type("application/vnd.apple.mpegurl");
    res.setHeader("Cache-Control", "no-store");
    res.send(playlist);
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : "Playlist unavailable" });
  }
});

app.get("/play/:sessionId/segment-:index.ts", async (req, res) => {
  try {
    const task = getVodSegment(req.params.sessionId, Number(req.params.index));
    if (!task) return res.status(404).json({ error: "VOD session not found" });
    const segmentPath = await task;
    res.type("video/mp2t");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.sendFile(segmentPath);
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : "Segment unavailable" });
  }
});

app.get("/api/settings", (req, res) => {
  const settings = getSettings();

  res.json({
    ...settings,
    debrid: {
      ...settings.debrid,
      apiKey: settings.debrid?.apiKey ? "********" : ""
    }
  });
});

app.patch("/api/settings", (req, res) => {
  const currentSettings = getSettings();

  const nextDebrid = {
    ...currentSettings.debrid,
    ...(req.body.debrid || {})
  };

  const nextFallback = {
    ...currentSettings.fallback,
    ...(req.body.fallback || {})
  };

  const nextMidstream = {
    ...currentSettings.midstream,
    ...(req.body.midstream || {})
  };

  if (req.body.debrid?.apiKey === "********") {
    nextDebrid.apiKey = currentSettings.debrid?.apiKey || "";
  }

  const newSettings = {
    ...currentSettings,
    ...req.body,
    fallback: nextFallback,
    midstream: nextMidstream,
    debrid: nextDebrid
  };

  saveSettings(newSettings);

  const savedSettings = getSettings();

  res.json({
    success: true,
    settings: {
      ...savedSettings,
      debrid: {
        ...savedSettings.debrid,
        apiKey: savedSettings.debrid?.apiKey ? "********" : ""
      }
    }
  });
});

app.get("/api/addons", (req, res) => {
  res.json(getAddons());
});

app.post("/api/addons", async (req, res) => {
  try {
    const addons = getAddons();
    const addon = await createAddon(req.body.url);

    const alreadyExists = addons.some(
      (item: any) =>
        item.url === addon.url ||
        item.manifestUrl === addon.manifestUrl
    );

    if (alreadyExists) {
      return res.status(400).json({
        success: false,
        error: "Addon already exists"
      });
    }

    addons.push(addon);
    saveAddons(addons);

    res.json({
      success: true,
      addon
    });
  } catch (error: any) {
    res.status(400).json({
      success: false,
      error: error.message || "Failed to add addon"
    });
  }
});

app.patch("/api/addons/:index", (req, res) => {
  const addons = getAddons();
  const index = Number(req.params.index);

  if (!addons[index]) {
    return res.status(404).json({
      success: false,
      error: "Addon not found"
    });
  }

  addons[index] = {
    ...addons[index],
    ...req.body
  };

  saveAddons(addons);

  res.json({
    success: true,
    addon: addons[index]
  });
});

app.delete("/api/addons/:index", (req, res) => {
  const addons = getAddons();
  const index = Number(req.params.index);

  if (!addons[index]) {
    return res.status(404).json({
      success: false,
      error: "Addon not found"
    });
  }

  addons.splice(index, 1);
  saveAddons(addons);

  res.json({ success: true });
});

const PORT = Number(process.env.PORT || 7001);

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `🚀 AutoStream v${APP_VERSION} running on http://localhost:${PORT}`
  );
});
