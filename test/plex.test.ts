import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { createAddon, isPlexAddon } from "../src/services/addons";

test("recognizes a configured Plexio manifest as a Plex source", async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      id: "com.stremio.plexio",
      name: "Plexio (Living Room)",
      version: "1.0.0",
      resources: ["stream"],
      types: ["movie", "series"]
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const addon = await createAddon(`http://127.0.0.1:${address.port}/manifest.json`);
    assert.equal(isPlexAddon(addon), true);
    assert.equal(addon.sourceKind, "plex");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())
    );
  }
});
