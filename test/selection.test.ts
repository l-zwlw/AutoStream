import assert from "node:assert/strict";
import test from "node:test";

import { deduplicateStreams } from "../src/services/dedupe";
import { rankStreams } from "../src/services/sorter";
import { verifiedSelectionKey } from "../src/streams";
import { fastestSuccessfulCandidate } from "../src/services/qbittorrent";

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

test("prefers a well-seeded compact 720p stream over a weak large 1080p stream", () => {
  const streams = [
    {
      infoHash: "a".repeat(40),
      title: "The Muppets S01E01 1080p WEB-DL HEVC 👤 5 💾 12 GB"
    },
    {
      infoHash: "b".repeat(40),
      title: "The Muppets S01E01 720p WEBRip H264 👤 60 💾 2 GB"
    }
  ];
  const ranked = rankStreams(streams, {
    profile: "balanced",
    rules: {
      minimumQuality: "720p",
      maximumQuality: "4k",
      maximumSizeGb: 0,
      minimumSeeders: 0,
      allowRemux: true
    }
  });
  assert.match(ranked[0].title, /720p/);
});

test("seed availability outweighs premium format bonuses", () => {
  const streams = [
    {
      infoHash: "c".repeat(40),
      title: "Show S01E02 4K REMUX HDR Dolby Vision Atmos 👤 2 💾 45 GB"
    },
    {
      infoHash: "d".repeat(40),
      title: "Show S01E02 720p WEB-DL H264 👤 90 💾 1.4 GB"
    }
  ];
  const ranked = rankStreams(streams, {
    profile: "balanced",
    rules: {
      minimumQuality: "720p",
      maximumQuality: "4k",
      maximumSizeGb: 0,
      minimumSeeders: 0,
      allowRemux: true
    }
  });
  assert.match(ranked[0].title, /720p/);
});

test("highest-seeded practical release wins across all quality buckets", () => {
  const streams = [
    {
      infoHash: "1".repeat(40),
      title: "Show S01E01 2160p REMUX HDR Atmos 👤 3 💾 48 GB"
    },
    {
      infoHash: "2".repeat(40),
      title: "Show S01E01 1080p WEB-DL HEVC 👤 14 💾 8 GB"
    },
    {
      infoHash: "3".repeat(40),
      title: "Show S01E01 720p WEB-DL H264 👤 120 💾 1.2 GB"
    }
  ];

  const ranked = rankStreams(streams, {
    profile: "balanced",
    rules: {
      minimumQuality: "720p",
      maximumQuality: "4k",
      maximumSizeGb: 0,
      minimumSeeders: 0,
      allowRemux: true
    }
  });

  assert.equal(ranked[0].infoHash, "3".repeat(40));
});

test("filters explicitly labelled foreign-only audio while allowing unlabelled original audio", () => {
  const ranked = rankStreams([
    { title: "Scorpion.S01E01.1080p.WEB-DL.POLISH.LEKTOR 👤 80 💾 2 GB" },
    { title: "Scorpion.S01E01.720p.WEB-DL.x264 👤 30 💾 1 GB" }
  ], {
    rules: {
      minimumQuality: "720p",
      maximumQuality: "4k",
      allowedAudioLanguages: ["english"]
    }
  });

  assert.equal(ranked.length, 1);
  assert.match(ranked[0].title, /720p/);
});

test("accepts multi-audio releases when one allowed language is present", () => {
  const ranked = rankStreams([
    { title: "Scorpion.S01E01.1080p.MULTI.POLISH.ENGLISH 👤 20 💾 2 GB" }
  ], {
    rules: {
      minimumQuality: "720p",
      maximumQuality: "4k",
      allowedAudioLanguages: ["english"]
    }
  });

  assert.equal(ranked.length, 1);
});

test("applies the audio allowlist to languages other than Polish", () => {
  const ranked = rankStreams([
    { title: "Scorpion.S01E01.1080p.WEB-DL.GERMAN 👤 50 💾 2 GB" },
    { title: "Scorpion.S01E01.1080p.WEB-DL.RUSSIAN 👤 40 💾 2 GB" },
    { title: "Scorpion.S01E01.720p.WEB-DL.ENGLISH 👤 20 💾 1 GB" }
  ], {
    rules: {
      minimumQuality: "720p",
      maximumQuality: "4k",
      allowedAudioLanguages: ["english"]
    }
  });

  assert.equal(ranked.length, 1);
  assert.match(ranked[0].title, /ENGLISH/);
});

test("rejects an unlabelled dubbed release when a language allowlist is active", () => {
  const ranked = rankStreams([
    { title: "Scorpion.S01E01.1080p.WEB-DL.DUBBED 👤 50 💾 2 GB" }
  ], {
    rules: {
      minimumQuality: "720p",
      maximumQuality: "4k",
      allowedAudioLanguages: ["english"]
    }
  });

  assert.equal(ranked.length, 0);
});

test("verified selection cache is isolated per episode and settings", () => {
  const settings = {
    profile: "balanced",
    rules: { minimumQuality: "720p" }
  };

  assert.notEqual(
    verifiedSelectionKey("series", "tt8910922:4:1", settings),
    verifiedSelectionKey("series", "tt8910922:4:2", settings)
  );
  assert.notEqual(
    verifiedSelectionKey("series", "tt8910922:4:1", settings),
    verifiedSelectionKey("series", "tt8910922:4:1", {
      ...settings,
      rules: { minimumQuality: "1080p" }
    })
  );
});

test("measured throughput beats statistical rank after candidates become playable", () => {
  const statisticalWinner = {
    id: "statistical",
    rank: 0,
    averageSpeed: 350_000,
    newlyDownloadedBytes: 1_500_000,
    attempt: { success: true }
  };
  const measuredWinner = {
    id: "measured",
    rank: 3,
    averageSpeed: 1_800_000,
    newlyDownloadedBytes: 5_000_000,
    attempt: { success: true }
  };

  assert.equal(
    fastestSuccessfulCandidate([statisticalWinner, measuredWinner])?.id,
    "measured"
  );
});
