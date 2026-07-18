import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("migrates the default legacy viewer profile to global settings once", () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "autostream-settings-"));
  fs.writeFileSync(
    path.join(dataRoot, "settings.json"),
    JSON.stringify({ profile: "fastest", playbackMethod: "torrent" })
  );
  fs.writeFileSync(
    path.join(dataRoot, "profiles.json"),
    JSON.stringify([
      {
        id: "default",
        name: "Living room",
        settings: {
          profile: "balanced",
          playbackMethod: "torrent",
          addonIds: ["torrentio-instance"],
          addonSelectionConfigured: true,
          rules: { allowedAudioLanguages: ["english", "dutch"] },
          jackett: {
            enabled: true,
            url: "http://jackett:9117",
            apiKey: "keep-me",
            indexer: "all"
          }
        }
      }
    ])
  );

  const moduleUrl = new URL("../src/services/settings.ts", import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      `const { getSettings } = await import(${JSON.stringify(moduleUrl)}); console.log(JSON.stringify(getSettings()));`
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, AUTOSTREAM_DATA_PATH: dataRoot },
      encoding: "utf8"
    }
  );

  assert.equal(result.status, 0, result.stderr);
  const settings = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
  assert.equal(settings.profile, "balanced");
  assert.deepEqual(settings.addonIds, ["torrentio-instance"]);
  assert.deepEqual(settings.rules.allowedAudioLanguages, ["english", "dutch"]);
  assert.equal(settings.jackett.apiKey, "keep-me");
  assert.equal(fs.existsSync(path.join(dataRoot, "profiles.json")), false);
  assert.equal(fs.existsSync(path.join(dataRoot, "profiles.legacy.json")), true);

  fs.rmSync(dataRoot, { recursive: true, force: true });
});
