import assert from "node:assert/strict";
import test from "node:test";

import { getJackettStreams } from "../src/providers/jackett";

test("converts an exact Jackett episode result into an AutoStream candidate", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(`<?xml version="1.0"?>
    <rss xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel>
      <item><title>The.Muppets.Mayhem.S01E01.720p.WEBRip.x264</title><size>248627200</size>
        <torznab:attr name="seeders" value="23" />
        <torznab:attr name="infohash" value="${"a".repeat(40)}" />
        <torznab:attr name="tracker" value="Test Indexer" />
      </item>
      <item><title>The.Muppets.Mayhem.S01.COMPLETE.1080p</title><size>9999999999</size>
        <torznab:attr name="seeders" value="100" />
        <torznab:attr name="infohash" value="${"b".repeat(40)}" />
      </item>
    </channel></rss>`, { status: 200 });
  try {
    const streams = await getJackettStreams("series", "tt18545980:1:1", {
      enabled: true,
      url: "http://jackett:9117",
      apiKey: "test-key",
      indexer: "all"
    });
    assert.equal(streams.length, 1);
    assert.equal((streams[0] as any).infoHash, "a".repeat(40));
    assert.match((streams[0] as any).title, /👤 23/);
    assert.match((streams[0] as any).title, /Test Indexer/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not query Jackett until it is enabled and configured", async () => {
  assert.deepEqual(await getJackettStreams("movie", "tt0133093", {}), []);
  assert.deepEqual(await getJackettStreams("movie", "tt0133093", { enabled: true }), []);
});
