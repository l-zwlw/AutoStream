import express from "express";
import cors from "cors";
import path from "node:path";

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
  createStreamingSession,
  getStreamingSegmentPath,
  getStreamingSession,
  getStreamingSessions,
  restoreStreamingSessions,
  touchStreamingSession,
  waitForPlaylist
} from "./services/streaming";
import { APP_VERSION, RELEASE_CHANNEL } from "./version";
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

app.get("/manifest.json", (req, res) => {
  res.json(manifest);
});

app.get("/p/:profileId/manifest.json", (req, res) => {
  const profile = getProfile(req.params.profileId);
  if (!profile) return res.status(404).json({ error: "Profile not found" });

  res.json({
    ...manifest,
    id: `${manifest.id}.${profile.id}`,
    name: `${manifest.name} · ${profile.name}`,
    description: `${manifest.description} Profile: ${profile.name}.`
  });
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
    midstreamEnabled:
      settings.midstream?.enabled === true &&
      settings.profile !== "debrid",
    streamingSessions: getStreamingSessions().length,
    httpStreamingAvailable: experimentalHttpEnabled,
    fallbackEngine: qbittorrent
  });
});

app.get("/api/qbittorrent/status", async (req, res) => {
  const status = await getQBittorrentStatus();

  res.status(status.online ? 200 : 503).json(status);
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
  res.json(getStreamingSessions());
});

app.get("/api/streaming/sessions/:id", (req, res) => {
  const session = getStreamingSession(req.params.id);

  if (!session) {
    return res.status(404).json({ error: "Streaming session not found" });
  }

  res.json(session);
});

app.post("/api/streaming/test", async (req, res) => {
  if (process.env.STREAMING_TEST_MODE !== "true") {
    return res.status(404).json({ error: "Not found" });
  }

  try {
    const settings = getSettings();
    const session = await createStreamingSession(
      Array.isArray(req.body.candidates) ? req.body.candidates : [],
      settings.fallback,
      settings.midstream
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
  const playlistPath = await waitForPlaylist(req.params.sessionId);

  if (!playlistPath) {
    return res.status(503).json({
      error: "Streaming playlist is not ready"
    });
  }

  res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.sendFile(playlistPath);
});

app.get("/play/:sessionId/:segment", (req, res) => {
  const segmentPath = getStreamingSegmentPath(
    req.params.sessionId,
    req.params.segment
  );

  if (!segmentPath) {
    return res.status(404).json({ error: "Streaming segment not found" });
  }

  touchStreamingSession(req.params.sessionId);
  res.setHeader("Content-Type", "video/mp2t");
  res.setHeader("Cache-Control", "public, max-age=3600, immutable");
  res.sendFile(segmentPath);
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

if (
  experimentalHttpEnabled &&
  getProfiles().some(
    (profile) => profile.settings.playbackMethod === "http"
  )
) {
  restoreStreamingSessions();
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `🚀 AutoStream v${APP_VERSION} running on http://localhost:${PORT}`
  );
});
