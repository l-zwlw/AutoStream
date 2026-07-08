import fs from "fs";
import path from "path";

const settingsFile = path.join(process.cwd(), "data/settings.json");

const defaultSettings = {
  profile: "balanced",
  debrid: {
    enabled: false,
    provider: "",
    apiKey: ""
  }
};

export function getSettings() {
  if (!fs.existsSync(settingsFile)) {
    saveSettings(defaultSettings);
    return defaultSettings;
  }

  const settings = JSON.parse(fs.readFileSync(settingsFile, "utf-8"));

  return {
    ...defaultSettings,
    ...settings,
    debrid: {
      ...defaultSettings.debrid,
      ...(settings.debrid || {})
    }
  };
}

export function saveSettings(settings: any) {
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
}
