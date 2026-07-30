import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import {
  selectFirstPlayableHttp,
  verifyHttpStream
} from "../src/services/httpStreams";

async function testServer(
  handler: http.RequestListener,
  run: (baseUrl: string) => Promise<void>
) {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const previous = process.env.ALLOW_PRIVATE_HTTP_STREAMS;
  process.env.ALLOW_PRIVATE_HTTP_STREAMS = "true";
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    if (previous === undefined) delete process.env.ALLOW_PRIVATE_HTTP_STREAMS;
    else process.env.ALLOW_PRIVATE_HTTP_STREAMS = previous;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())
    );
  }
}

test("accepts a direct HTTP source only after media bytes arrive", async () => {
  await testServer((_request, response) => {
    response.writeHead(206, {
      "Content-Type": "video/mp4",
      "Content-Range": "bytes 0-65535/1000000"
    });
    response.end(Buffer.alloc(64 * 1024, 1));
  }, async (baseUrl) => {
    const result = await verifyHttpStream({ url: `${baseUrl}/movie.mp4` });
    assert.equal(result.success, true);
    assert.equal(result.bytes, 64 * 1024);
  });
});

test("rejects HTTP 200 webpages masquerading as streams", async () => {
  await testServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end("<html>login required</html>");
  }, async (baseUrl) => {
    const result = await verifyHttpStream({ url: `${baseUrl}/watch` });
    assert.equal(result.success, false);
    assert.match(result.reason, /webpage|API error/);
  });
});

test("validates an HLS playlist through its first media segment", async () => {
  await testServer((request, response) => {
    if (request.url === "/index.m3u8") {
      response.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
      response.end("#EXTM3U\n#EXTINF:4,\nsegment.ts\n");
      return;
    }
    response.writeHead(206, { "Content-Type": "video/mp2t" });
    response.end(Buffer.alloc(32 * 1024, 2));
  }, async (baseUrl) => {
    const selection = await selectFirstPlayableHttp([
      { url: `${baseUrl}/index.m3u8`, title: "Show 1080p" }
    ]);
    assert.equal(selection.stream?.url, `${baseUrl}/index.m3u8`);
    assert.equal(selection.attempts.some((attempt) => attempt.success), true);
  });
});
