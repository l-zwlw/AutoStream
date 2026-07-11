type Settings = {
  profile?: string;
  debrid?: {
    enabled?: boolean;
    provider?: string;
    apiKey?: string;
  };
};

function getText(stream: any) {
  return `${stream.name || ""} ${stream.title || ""} ${stream.behaviorHints?.filename || ""}`.toLowerCase();
}

function getSeeders(text: string) {
  const patterns = [
    /👤\s*(\d+)/,
    /seeders?\s*[:\-]?\s*(\d+)/i,
    /seeds?\s*[:\-]?\s*(\d+)/i,
    /(\d+)\s*seeders?/i,
    /(\d+)\s*seeds?/i,
    /\bs\s*[:\-]?\s*(\d+)/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return Number(match[1]);
  }

  return 0;
}

function getSizeGb(text: string) {
  const gbMatch = text.match(/💾\s*([\d.]+)\s*gb/i) || text.match(/([\d.]+)\s*gb/i);
  const mbMatch = text.match(/💾\s*([\d.]+)\s*mb/i) || text.match(/([\d.]+)\s*mb/i);

  if (gbMatch) return Number(gbMatch[1]);
  if (mbMatch) return Number(mbMatch[1]) / 1024;

  return 0;
}

function isBadStream(text: string) {
  return (
    text.includes(" cam ") ||
    text.includes(".cam.") ||
    text.includes("camrip") ||
    text.includes(" telesync ") ||
    text.includes(" ts ") ||
    text.includes(".ts.") ||
    text.includes("hdts") ||
    text.includes("hdtc") ||
    text.includes("screener") ||
    text.includes("dvdscr") ||
    text.includes("3d") ||
    text.includes("hsbs") ||
    text.includes("sbs")
  );
}

function getQuality(text: string) {
  if (text.includes("2160p") || text.includes("4k")) return "4k";
  if (text.includes("1080p")) return "1080p";
  if (text.includes("720p")) return "720p";

  return "unknown";
}

function getQualityScore(text: string, profile: string) {
  const quality = getQuality(text);

  if (profile === "debrid") {
    if (quality === "4k") return 135;
    if (quality === "1080p") return 85;
    if (quality === "720p") return 35;
  }

  if (profile === "homeTheater") {
    if (quality === "4k") return 120;
    if (quality === "1080p") return 70;
    if (quality === "720p") return 35;
  }

  if (profile === "mobile") {
    if (quality === "720p") return 90;
    if (quality === "1080p") return 80;
    if (quality === "4k") return 20;
  }

  if (profile === "fastest") {
    if (quality === "720p") return 80;
    if (quality === "1080p") return 75;
    if (quality === "4k") return 35;
  }

  if (quality === "1080p") return 90;
  if (quality === "4k") return 75;
  if (quality === "720p") return 55;

  return 0;
}

function getSizeScore(sizeGb: number, profile: string) {
  if (!sizeGb) return 0;

  if (profile === "debrid") {
    if (sizeGb <= 8) return 5;
    if (sizeGb <= 80) return 0;
    return -5;
  }

  if (profile === "homeTheater") {
    if (sizeGb <= 8) return 10;
    if (sizeGb <= 20) return 15;
    if (sizeGb <= 50) return 10;
    return -5;
  }

  if (profile === "mobile") {
    if (sizeGb <= 2) return 50;
    if (sizeGb <= 4) return 35;
    if (sizeGb <= 8) return 10;
    if (sizeGb <= 15) return -20;
    return -60;
  }

  if (profile === "fastest") {
    if (sizeGb <= 2) return 60;
    if (sizeGb <= 5) return 45;
    if (sizeGb <= 10) return 15;
    if (sizeGb <= 20) return -20;
    return -70;
  }

  if (sizeGb <= 3) return 35;
  if (sizeGb <= 8) return 30;
  if (sizeGb <= 15) return 15;
  if (sizeGb <= 25) return -5;
  if (sizeGb <= 40) return -25;
  return -55;
}

function getSeederScore(seeders: number, profile: string) {
  if (!seeders) return 0;

  if (profile === "debrid") return Math.min(seeders, 25);
  if (profile === "fastest") return Math.min(seeders * 1.5, 120);
  if (profile === "mobile") return Math.min(seeders, 90);
  if (profile === "homeTheater") return Math.min(seeders, 60);

  return Math.min(seeders, 90);
}

function getDebridScore(text: string) {
  let score = 0;

  if (text.includes("cached")) score += 80;
  if (text.includes("debrid")) score += 60;
  if (text.includes("real-debrid") || text.includes("realdebrid")) score += 35;
  if (text.includes("alldebrid")) score += 35;
  if (text.includes("premiumize")) score += 35;
  if (text.includes("torbox")) score += 35;

  return score;
}

export function rankStreams(streams: any[], settings: Settings = {}) {
  if (!streams.length) {
    return [];
  }

  const profile = settings.profile || "balanced";
  const debridConfigured = Boolean(settings.debrid?.provider && settings.debrid?.apiKey);
  const effectiveProfile = profile === "debrid" && debridConfigured ? "debrid" : profile;

  const scored = streams
    .filter((stream) => {
      const text = getText(stream);

      if (isBadStream(text)) return false;

      const quality = getQuality(text);

      return quality !== "unknown";
    })
    .map((stream) => {
      const text = getText(stream);

      let score = 0;

      const seeders = getSeeders(text);
      const sizeGb = getSizeGb(text);

      score += getQualityScore(text, effectiveProfile);
      score += getSizeScore(sizeGb, effectiveProfile);
      score += getSeederScore(seeders, effectiveProfile);

      if (effectiveProfile === "debrid") {
        score += getDebridScore(text);
      }

      if (text.includes("remux")) score += effectiveProfile === "debrid" || effectiveProfile === "homeTheater" ? 45 : 5;
      if (text.includes("bluray") || text.includes("blu-ray")) score += 20;
      if (text.includes("web-dl")) score += 15;
      if (text.includes("webrip")) score += 5;

      if (text.includes("dolby vision") || text.includes(" dv ")) score += effectiveProfile === "debrid" || effectiveProfile === "homeTheater" ? 30 : 8;
      if (text.includes("hdr10+")) score += effectiveProfile === "debrid" || effectiveProfile === "homeTheater" ? 25 : 6;
      if (text.includes("hdr")) score += effectiveProfile === "debrid" || effectiveProfile === "homeTheater" ? 18 : 5;

      if (text.includes("hevc") || text.includes("x265") || text.includes("h265")) score += 10;
      if (text.includes("av1")) score += 8;
      if (text.includes("x264") || text.includes("h264")) score += 4;

      if (text.includes("atmos")) score += effectiveProfile === "debrid" || effectiveProfile === "homeTheater" ? 20 : 3;
      if (text.includes("truehd")) score += effectiveProfile === "debrid" || effectiveProfile === "homeTheater" ? 15 : 2;
      if (text.includes("dts-hd")) score += effectiveProfile === "debrid" || effectiveProfile === "homeTheater" ? 15 : 2;

      if (seeders > 0 && seeders < 5) {
        score -= effectiveProfile === "debrid" || effectiveProfile === "homeTheater" ? 10 : 30;
      }

      return {
        stream,
        score
      };
    })
    .sort((a, b) => b.score - a.score);

  if (!scored.length) {
    return [];
  }

  console.log("Profile:", effectiveProfile);
  return scored.map((item) => item.stream);
}

export function pickBestStream(streams: any[], settings: Settings = {}) {
  const ranked = rankStreams(streams, settings);

  if (!ranked.length) {
    return [];
  }

  console.log("Selected stream:", ranked[0].title);

  return [ranked[0]];
}
