import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

function run(script: string, environment: Record<string, string>) {
  return execFileSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script],
    {
      cwd: process.cwd(),
      env: { ...process.env, ...environment },
      encoding: "utf8"
    }
  );
}

test("migrates settings, addons and dashboard password into persistent storage", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "autostream-persistence-"));
  const legacy = path.join(root, "legacy");
  const persistent = path.join(root, "volume");
  fs.mkdirSync(legacy);

  run(`
    const { saveSettings } = await import('./src/services/settings.ts');
    const { saveAddons } = await import('./src/services/addons.ts');
    const { setPassword } = await import('./src/services/auth.ts');
    saveSettings({ rules: { minimumQuality: '1080p' } });
    saveAddons([{ id: 'example', instanceId: 'one', name: 'Example', enabled: true }]);
    setPassword('persistent-password');
  `, { AUTOSTREAM_DATA_PATH: legacy });

  const output = run(`
    const { migrateLegacyData } = await import('./src/services/storage.ts');
    migrateLegacyData();
    const { getSettings } = await import('./src/services/settings.ts');
    const { getAddons } = await import('./src/services/addons.ts');
    const { verifyPassword } = await import('./src/services/auth.ts');
    console.log(JSON.stringify({
      quality: getSettings().rules.minimumQuality,
      addons: getAddons().length,
      password: verifyPassword('persistent-password')
    }));
  `, {
    AUTOSTREAM_DATA_PATH: persistent,
    AUTOSTREAM_LEGACY_DATA_PATH: legacy
  });
  const result = JSON.parse(output.trim().split("\n").pop()!);
  assert.deepEqual(result, { quality: "1080p", addons: 1, password: true });
});
