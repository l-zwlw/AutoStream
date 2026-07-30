import assert from "node:assert/strict";
import test from "node:test";

import { deduplicateStreams } from "../src/services/dedupe";
import { rankStreams } from "../src/services/sorter";
import { verifiedSelectionKey } from "../src/streams";
import {
  contiguousReadyBytes,
  oneCandidatePerQuality,
  requiredVideoProofBytes,
  verificationCandidatesByWave,
  verificationCandidateOrder,
  torrentSourcesWithDefaults
} from "../src/services/qbittorrent";

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

test("verification gives practical quality alternatives an early slot", () => {
  const ordered = verificationCandidateOrder([
    { title: "First 1080p" },
    { title: "Second 1080p" },
    { title: "Third 1080p" },
    { title: "Working 720p" }
  ]);
  assert.deepEqual(
    ordered.slice(0, 2).map((candidate) => candidate.title),
    ["First 1080p", "Working 720p"]
  );
});

test("verification races exactly one torrent per quality", () => {
  const selected = oneCandidatePerQuality([
    { title: "First 1080p" },
    { title: "Second 1080p" },
    { title: "First 720p" },
    { title: "Second 720p" },
    { title: "First 2160p" }
  ]);
  assert.deepEqual(
    selected.map((candidate) => candidate.title),
    ["First 1080p", "First 720p", "First 2160p"]
  );
});

test("verification schedules the next candidate in each quality as a later wave", () => {
  const plan = verificationCandidatesByWave([
    { title: "First 1080p" },
    { title: "Second 1080p" },
    { title: "First 720p" },
    { title: "Second 720p" },
    { title: "First 2160p" }
  ], 5);

  assert.deepEqual(
    plan.map(({ candidate, wave }) => [candidate.title, wave]),
    [
      ["First 1080p", 0],
      ["First 720p", 0],
      ["First 2160p", 0],
      ["Second 1080p", 1],
      ["Second 720p", 1]
    ]
  );
});

test("video proof is 0.01 percent with a 256 KB floor and 4 MB cap", () => {
  const configured = 256 * 1024;
  assert.equal(
    requiredVideoProofBytes(800 * 1024 * 1024, configured),
    configured
  );
  assert.equal(
    requiredVideoProofBytes(30 * 1024 * 1024 * 1024, configured),
    Math.ceil(30 * 1024 * 1024 * 1024 * 0.0001)
  );
  assert.equal(
    requiredVideoProofBytes(100 * 1024 * 1024 * 1024, configured),
    4 * 1024 * 1024
  );
  assert.equal(requiredVideoProofBytes(10, configured), configured);
});

test("only contiguous completed pieces from the start count as playable proof", () => {
  const pieceSize = 256 * 1024;

  assert.equal(
    contiguousReadyBytes([0, 2, 2, 0, 2], 1, 4, pieceSize, 4 * pieceSize),
    2 * pieceSize
  );
  assert.equal(
    contiguousReadyBytes([0, 0, 2, 2, 2], 1, 4, pieceSize, 4 * pieceSize),
    0
  );
  assert.equal(
    contiguousReadyBytes([2, 2, 2], 0, 2, pieceSize, 600_000),
    600_000
  );
});

test("passthrough winners receive peer discovery trackers", () => {
  const sources = torrentSourcesWithDefaults([
    "dht:abc",
    "tracker:udp://custom.example:80/announce"
  ]);
  assert.ok(sources.includes("dht:abc"));
  assert.ok(sources.includes("tracker:udp://custom.example:80/announce"));
  assert.ok(
    sources.some((source) =>
      source.startsWith("tracker:udp://tracker.opentrackr.org")
    )
  );
  assert.equal(new Set(sources).size, sources.length);
});

test("Jackett candidates enter verification ahead of equivalent addon results", () => {
  const addon = {
    infoHash: "a".repeat(40),
    title: "Show S02E11 1080p WEB-DL 👤 40 💾 2 GB",
    _autostreamAddonId: "torrentio"
  };
  const jackett = {
    ...addon,
    infoHash: "b".repeat(40),
    _autostreamAddonId: "jackett"
  };
  assert.equal(rankStreams([addon, jackett], {
    rules: {
      minimumQuality: "720p",
      maximumQuality: "4k",
      maximumSizeGb: 0,
      minimumSeeders: 0,
      allowedAudioLanguages: ["english"],
      allowRemux: true
    },
    device: {
      supports4k: true,
      supportsDolbyVision: true,
      supportsHdr: true,
      supportsHevc: true,
      supportsAv1: true
    }
  })[0]._autostreamAddonId, "jackett");
  assert.equal(
    verificationCandidateOrder([addon, jackett])[0]._autostreamAddonId,
    "jackett"
  );
});

test("single-season releases are verified before large multi-season packs", () => {
  const multiSeason = {
    infoHash: "a".repeat(40),
    title: "Solar.Opposites.S01-S06.Specials.1080p.WEB-DL 👤 28 💾 609 MB"
  };
  const singleSeason = {
    infoHash: "b".repeat(40),
    title: "Solar.Opposites.S04.COMPLETE.1080p.WEB-DL 👤 14 💾 412 MB"
  };

  const ranked = rankStreams([multiSeason, singleSeason], {
    profile: "balanced",
    rules: {
      minimumQuality: "720p",
      maximumQuality: "4k",
      maximumSizeGb: 0,
      minimumSeeders: 0,
      allowRemux: true
    }
  });

  assert.equal(ranked[0].infoHash, singleSeason.infoHash);
});
