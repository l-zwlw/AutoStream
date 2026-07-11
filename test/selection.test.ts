import assert from "node:assert/strict";
import test from "node:test";

import { deduplicateStreams } from "../src/services/dedupe";
import { rankStreams } from "../src/services/sorter";

test("deduplicates the same torrent and file index", () => {
  const streams = [
    { infoHash: "a".repeat(40), fileIdx: 2, title: "one" },
    { infoHash: "A".repeat(40), fileIdx: 2, title: "duplicate" },
    { infoHash: "a".repeat(40), fileIdx: 3, title: "different episode" }
  ];
  assert.equal(deduplicateStreams(streams).length, 2);
});

test("filters streams that exceed device capabilities", () => {
  const streams = [
    { title: "Movie 2160p Dolby Vision HEVC 20 seeders 10 GB" },
    { title: "Movie 1080p H264 30 seeders 4 GB" }
  ];
  const ranked = rankStreams(streams, {
    profile: "balanced",
    device: {
      supports4k: false,
      supportsDolbyVision: false,
      supportsHdr: false,
      supportsHevc: false,
      supportsAv1: false
    },
    rules: {
      minimumQuality: "720p",
      maximumQuality: "4k",
      maximumSizeGb: 0,
      minimumSeeders: 0,
      allowRemux: true
    }
  });
  assert.equal(ranked.length, 1);
  assert.match(ranked[0].title, /1080p/);
});

test("applies size and seeder rules", () => {
  const streams = [
    { title: "Movie 1080p H264 2 seeders 3 GB" },
    { title: "Movie 1080p H264 20 seeders 12 GB" },
    { title: "Movie 1080p H264 20 seeders 5 GB" }
  ];
  const ranked = rankStreams(streams, {
    rules: {
      minimumQuality: "720p",
      maximumQuality: "4k",
      maximumSizeGb: 8,
      minimumSeeders: 5,
      allowRemux: true
    }
  });
  assert.equal(ranked.length, 1);
  assert.match(ranked[0].title, /5 GB/);
});
