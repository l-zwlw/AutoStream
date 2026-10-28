import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("reuses fresh addon results immediately while refreshing in the background", async () => {
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "autostream-addon-cache-"));
  process.env.AUTOSTREAM_DATA_PATH = dataDirectory;

  const server = http.createServer((_request, response) => {
    setTimeout(() => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        streams: [{
          infoHash: "0123456789abcdef0123456789abcdef01234567",
          title: "Cached test stream"
        }]
      }));
    }, 250);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");

  fs.writeFileSync(
    path.join(dataDirectory, "addons.json"),
    JSON.stringify([{
      id: "test.addon",
      instanceId: "test.addon:cache",
      name: "Cache Test",
      url: `http://127.0.0.1:${address.port}`,
      manifestUrl: `http://127.0.0.1:${address.port}/manifest.json`,
      enabled: true
    }])
  );

  try {
    const { getAddonStreams } = await import("../src/providers/addons");
    const firstStartedAt = Date.now();
    const first = await getAddonStreams("movie", "tt0000001");
    const firstDuration = Date.now() - firstStartedAt;

    const secondStartedAt = Date.now();
    const second = await getAddonStreams("movie", "tt0000001");
    const secondDuration = Date.now() - secondStartedAt;

    assert.equal(first.length, 1);
    assert.equal(second.length, 1);
    assert(firstDuration >= 200, `first request unexpectedly took ${firstDuration}ms`);
    assert(secondDuration < 100, `cached request took ${secondDuration}ms`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  }
});
