type Settings = {
  addonPriorities?: Record<string, number>;
  device?: Record<string, any>;
  rules?: Record<string, any>;
  debrid?: {
    enabled?: boolean;
    provider?: string;
    apiKey?: string;
  };
};

import { getAddonReliability, getStreamReliability } from "./health";

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

function isMultiSeasonPack(text: string) {
  const normalized = text.replace(/[._+()[\]{}]/g, " ");
  return (
    /\bs\d{1,2}\s*[-–]\s*s\d{1,2}\b/i.test(normalized) ||
    /\bseasons?\s*:?\s*\d{1,2}\s*(?:[-–]|to)\s*\d{1,2}\b/i.test(normalized)
  );
}

function getQuality(text: string) {
  if (text.includes("2160p") || text.includes("4k")) return "4k";
  if (text.includes("1080p")) return "1080p";
  if (text.includes("720p")) return "720p";

  return "unknown";
}

function matchesLanguage(text: string, requested: string) {
  const language = requested.trim().toLowerCase();
  if (!language) return true;
  const aliases: Record<string, string[]> = {
    english: ["english", " eng ", "🇬🇧", "🇺🇸"],
    dutch: ["dutch", " nederlands", " nl ", "🇳🇱"],
    german: ["german", " deutsch", " ger ", "🇩🇪"],
    french: ["french", " français", " fre ", "🇫🇷"],
    spanish: ["spanish", " español", " spa ", "🇪🇸"],
    italian: ["italian", " italiano", " ita ", "🇮🇹"]
  };
  const values = aliases[language] || [language];
  return values.some((value) => ` ${text} `.includes(value));
}

const audioLanguagePatterns: Record<string, RegExp[]> = {
  english: [/\benglish\b/i, /\beng\b/i, /🇬🇧|🇺🇸/],
  dutch: [/\bdutch\b/i, /\bnederlands?\b/i, /\bnld\b/i, /🇳🇱/],
  german: [/\bgerman\b/i, /\bdeutsch\b/i, /\bger\b/i, /🇩🇪/],
  french: [/\bfrench\b/i, /\bfran[cç]ais\b/i, /\bfre\b/i, /🇫🇷/],
  spanish: [/\bspanish\b/i, /\bespa[nñ]ol\b/i, /\bspa\b/i, /🇪🇸/],
  italian: [/\bitalian\b/i, /\bitaliano\b/i, /\bita\b/i, /🇮🇹/],
  polish: [/\bpolish\b/i, /\bpolski\b/i, /\bpol\b/i, /\bpl\b/i, /\blektor\b/i, /🇵🇱/],
  portuguese: [/\bportuguese\b/i, /\bportugu[eê]s\b/i, /\bpor\b/i, /\bpt(?:-br)?\b/i, /🇵🇹|🇧🇷/],
  japanese: [/\bjapanese\b/i, /\bjpn\b/i, /\bja\b/i, /🇯🇵/],
  korean: [/\bkorean\b/i, /\bkor\b/i, /\bko\b/i, /🇰🇷/],
  chinese: [/\bchinese\b/i, /\bmandarin\b/i, /\bcantonese\b/i, /\bchi\b/i, /\bzho\b/i, /🇨🇳|🇭🇰|🇹🇼/],
  russian: [/\brussian\b/i, /\brus\b/i, /🇷🇺/],
  ukrainian: [/\bukrainian\b/i, /\bukr\b/i, /🇺🇦/],
  czech: [/\bczech\b/i, /\bcesky\b/i, /\bcze\b/i, /🇨🇿/],
  hungarian: [/\bhungarian\b/i, /\bmagyar\b/i, /\bhun\b/i, /🇭🇺/],
  turkish: [/\bturkish\b/i, /\bt[uü]rk[cç]e\b/i, /\btur\b/i, /🇹🇷/],
  arabic: [/\barabic\b/i, /\bara\b/i, /🇸🇦|🇦🇪|🇪🇬/],
  hindi: [/\bhindi\b/i, /\bhin\b/i, /🇮🇳/],
  swedish: [/\bswedish\b/i, /\bsvenska\b/i, /\bswe\b/i, /🇸🇪/],
  norwegian: [/\bnorwegian\b/i, /\bnorsk\b/i, /\bnor\b/i, /🇳🇴/],
  danish: [/\bdanish\b/i, /\bdansk\b/i, /\bdan\b/i, /🇩🇰/],
  finnish: [/\bfinnish\b/i, /\bsuomi\b/i, /\bfin\b/i, /🇫🇮/],
  greek: [/\bgreek\b/i, /\bgre\b/i, /\bell\b/i, /🇬🇷/],
  hebrew: [/\bhebrew\b/i, /\bheb\b/i, /🇮🇱/],
  thai: [/\bthai\b/i, /\btha\b/i, /🇹🇭/],
  indonesian: [/\bindonesian\b/i, /\bbahasa\b/i, /\bind\b/i, /🇮🇩/],
  romanian: [/\bromanian\b/i, /\brom[aâ]n[aă]\b/i, /\bron\b/i, /🇷🇴/],
  bulgarian: [/\bbulgarian\b/i, /\bbul\b/i, /🇧🇬/],
  vietnamese: [/\bvietnamese\b/i, /\bvie\b/i, /🇻🇳/]
};

function normalizedReleaseText(text: string) {
  return text.replace(/[._+\-()[\]{}]/g, " ").replace(/\s+/g, " ");
}

function detectedAudioLanguages(text: string) {
  const normalized = normalizedReleaseText(text);
  return Object.entries(audioLanguagePatterns)
    .filter(([, patterns]) => patterns.some((pattern) => pattern.test(normalized)))
    .map(([language]) => language);
}

function matchesAudioRules(text: string, rules: Record<string, any>) {
  const allowed = Array.isArray(rules.allowedAudioLanguages)
    ? rules.allowedAudioLanguages.map((value: unknown) => String(value).toLowerCase())
    : [];
  if (!allowed.length && rules.preferredLanguage) {
    return matchesLanguage(text, String(rules.preferredLanguage));
  }
  if (!allowed.length) return true;
  const detected = detectedAudioLanguages(text);
  if (!detected.length) {
    if (/\bdubbed\b|\bdub\b/i.test(normalizedReleaseText(text))) return false;
    return true;
  }
  return detected.some((language) => allowed.includes(language));
}

const qualityRank: Record<string, number> = {
  unknown: 0,
  "720p": 1,
  "1080p": 2,
  "4k": 3
};

function qualityValue(quality: string) {
  return qualityRank[quality] ?? 0;
}

function getQualityScore(text: string) {
  const quality = getQuality(text);

  if (quality === "1080p") return 90;
  if (quality === "4k") return 75;
  if (quality === "720p") return 55;

  return 0;
}

function getSizeScore(sizeGb: number) {
  if (!sizeGb) return -40;

  if (sizeGb <= 1.5) return 180;
  if (sizeGb <= 3) return 160;
  if (sizeGb <= 6) return 110;
  if (sizeGb <= 10) return 60;
  if (sizeGb <= 20) return -20;
  if (sizeGb <= 40) return -140;
  return -300;
}

function getSeederScore(seeders: number) {
  if (!seeders) return 0;
  return Math.log2(seeders + 1) * 135;
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

  const debridConfigured = Boolean(
    settings.debrid?.enabled &&
    settings.debrid?.provider &&
    settings.debrid?.apiKey
  );
  const rules = settings.rules || {};
  const device = settings.device || {};

  const scored = streams
    .filter((stream) => {
      const text = getText(stream);

      if (isBadStream(text)) return false;

      const quality = getQuality(text);
      if (quality === "unknown") return false;
      if (
        rules.minimumQuality &&
        qualityValue(quality) < qualityValue(rules.minimumQuality)
      ) return false;
      if (
        rules.maximumQuality &&
        qualityValue(quality) > qualityValue(rules.maximumQuality)
      ) return false;
      if (!device.supports4k && quality === "4k") return false;
      if (!device.supportsDolbyVision && /dolby vision|\bdv\b/i.test(text)) return false;
      if (!device.supportsHdr && /hdr|dolby vision|\bdv\b/i.test(text)) return false;
      if (!device.supportsHevc && /hevc|x265|h.?265/i.test(text)) return false;
      if (!device.supportsAv1 && /\bav1\b/i.test(text)) return false;
      if (rules.allowRemux === false && text.includes("remux")) return false;
      const size = getSizeGb(text);
      if (rules.maximumSizeGb > 0 && size > rules.maximumSizeGb) return false;
      if (rules.minimumSeeders > 0 && getSeeders(text) < rules.minimumSeeders) return false;
      if (!matchesAudioRules(text, rules)) return false;
      return true;
    })
    .map((stream) => {
      const text = getText(stream);

      let score = 0;

      const seeders = getSeeders(text);
      const sizeGb = getSizeGb(text);

      score += getQualityScore(text);
      score += getSizeScore(sizeGb);
      score += getSeederScore(seeders);
      if (stream.infoHash && seeders === 0 && !debridConfigured) {
        score -= 180;
      }
      score += getAddonReliability(stream._autostreamAddonId) * 30;
      score += getStreamReliability(stream.infoHash) * 30;
      score += Number(settings.addonPriorities?.[stream._autostreamAddonId] || 0) * 10;

      // Large multi-season packs often look healthy by aggregate seeder count,
      // but are slower to resolve and less reliable in Stremio than an exact
      // episode or single-season pack. Keep them as fallback candidates rather
      // than letting them dominate the first verification batch.
      if (isMultiSeasonPack(text)) score -= 400;

      if (rules.preferHdr && /hdr|dolby vision|\bdv\b/i.test(text)) score += 20;
      if (rules.preferredCodec === "hevc" && /hevc|x265|h.?265/i.test(text)) score += 18;
      if (rules.preferredCodec === "av1" && /\bav1\b/i.test(text)) score += 18;
      if (rules.preferredCodec === "h264" && /h.?264|x264|avc/i.test(text)) score += 18;

      if (debridConfigured) {
        score += getDebridScore(text);
      }

      if (text.includes("remux")) score += debridConfigured ? 45 : 5;
      if (text.includes("bluray") || text.includes("blu-ray")) score += 20;
      if (text.includes("web-dl")) score += 15;
      if (text.includes("webrip")) score += 5;

      if (text.includes("dolby vision") || text.includes(" dv ")) score += debridConfigured ? 30 : 8;
      if (text.includes("hdr10+")) score += debridConfigured ? 25 : 6;
      if (text.includes("hdr")) score += debridConfigured ? 18 : 5;

      if (text.includes("hevc") || text.includes("x265") || text.includes("h265")) score += 10;
      if (text.includes("av1")) score += 8;
      if (text.includes("x264") || text.includes("h264")) score += 4;

      if (text.includes("atmos")) score += debridConfigured ? 20 : 3;
      if (text.includes("truehd")) score += debridConfigured ? 15 : 2;
      if (text.includes("dts-hd")) score += debridConfigured ? 15 : 2;

      if (seeders > 0 && seeders < 5) {
        score -= debridConfigured ? 10 : 30;
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

  console.log("Selection mode:", debridConfigured ? "debrid-aware" : "rules-based");
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
