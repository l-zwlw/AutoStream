import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

test("a fresh installation has no addons, preset or preconfigured password", () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "autostream-fresh-"));
  const script = `
    const { getAddons } = await import('./src/services/addons.ts');
    const { getSettings } = await import('./src/services/settings.ts');
    const { isPasswordConfigured, setPassword } = await import('./src/services/auth.ts');
    const before = {
      addons: getAddons(),
      settings: getSettings(),
      passwordConfigured: isPasswordConfigured()
    };
    setPassword('a-user-chosen-password');
    console.log(JSON.stringify({ before, afterPasswordConfigured: isPasswordConfigured() }));
  `;
  const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, AUTOSTREAM_DATA_PATH: dataRoot },
    encoding: "utf8"
  });
  const result = JSON.parse(output.trim());

  assert.deepEqual(result.before.addons, []);
  assert.equal("profile" in result.before.settings, false);
  assert.equal(result.before.passwordConfigured, false);
  assert.equal(result.afterPasswordConfigured, true);
});
