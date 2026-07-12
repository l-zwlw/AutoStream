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

test("falls back to a title search when Jackett indexers reject IMDb TV search", async () => {
  const originalFetch = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    requested.push(url);
    if (url.includes("v3-cinemeta")) {
      return new Response(JSON.stringify({ meta: { name: "9-1-1: Nashville" } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    const parsed = new URL(url);
    if (parsed.searchParams.has("imdbid")) {
      return new Response("<error code=\"203\" />", { status: 400 });
    }
    return new Response(`<?xml version="1.0"?>
      <rss xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel><item>
        <title>9-1-1.Nashville.S01E12.720p.WEB.x264</title><size>500000000</size>
        <torznab:attr name="seeders" value="18" />
        <torznab:attr name="infohash" value="${"c".repeat(40)}" />
      </item><item>
        <title>Nashville.2012.S01E12.720p.HDTV.x264</title><size>300000000</size>
        <torznab:attr name="seeders" value="100" />
        <torznab:attr name="infohash" value="${"d".repeat(40)}" />
      </item></channel></rss>`, { status: 200 });
  };
  try {
    const streams = await getJackettStreams("series", "tt33550053:1:12", {
      enabled: true,
      url: "http://jackett.example:9117",
      apiKey: "test-key",
      indexer: "all"
    });
    assert.equal(streams.length, 1);
    const textRequest = requested.find((url) => url.includes("q="));
    assert.ok(textRequest);
    assert.equal(new URL(textRequest).searchParams.get("q"), "9-1-1 Nashville S01E12");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
