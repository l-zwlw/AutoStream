import express from "express";
import cors from "cors";

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

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static("src/public"));

app.get("/manifest.json", (req, res) => {
  res.json(manifest);
});

app.get("/stream/:type/:id.json", async (req, res) => {
  try {
    const streams = await getStreams(
      req.params.type,
      req.params.id
    );

    res.json({ streams });
  } catch (error) {
    console.error("Stream error:", error);
    res.status(500).json({ streams: [] });
  }
});

app.get("/api/status", async (req, res) => {
  const settings = getSettings();
  const qbittorrent = await getQBittorrentStatus();

  res.json({
    status: "online",
    version: "1.0.0",
    addons: getAddons().length,
    profile: settings.profile || "balanced",
    debridEnabled: settings.debrid?.enabled || false,
    fallbackEngine: qbittorrent
  });
});

app.get("/api/qbittorrent/status", async (req, res) => {
  const status = await getQBittorrentStatus();

  res.status(status.online ? 200 : 503).json(status);
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

  if (req.body.debrid?.apiKey === "********") {
    nextDebrid.apiKey = currentSettings.debrid?.apiKey || "";
  }

  const newSettings = {
    ...currentSettings,
    ...req.body,
    debrid: nextDebrid
  };

  saveSettings(newSettings);

  res.json({
    success: true,
    settings: {
      ...newSettings,
      debrid: {
        ...newSettings.debrid,
        apiKey: newSettings.debrid?.apiKey ? "********" : ""
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
    `🚀 AutoStream v1.0.0 running on http://localhost:${PORT}`
  );
});
