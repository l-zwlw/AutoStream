import { getAddonStreams } from "./providers/addons";
import { rankStreams } from "./services/sorter";
import { getSettings } from "./services/settings";
import {
  getQBittorrentStatus,
  selectFirstPlayableTorrent
} from "./services/qbittorrent";
import { createVodSession } from "./services/vodStreaming";
import { deduplicateStreams } from "./services/dedupe";
import { recordStreamOutcome } from "./services/health";
import { getJackettStreams } from "./providers/jackett";

const experimentalHttpEnabled =
  process.env.ENABLE_EXPERIMENTAL_HTTP === "true";

const passthroughSelectionCache = new Map<
  string,
  { infoHash: string; expiresAt: number }
>();

function passthroughCacheKey(type: string, id: string, settings: any) {
  const [imdbId, season] = id.split(":");
  const content = type === "series" ? `${imdbId}:${season || ""}` : imdbId;
  return `${type}:${content}:${settings.profile || "balanced"}`;
}

function getProfileName(profile: string) {
  switch (profile) {
    case "balanced":
      return "⚖️ Balanced";

    case "fastest":
      return "⚡ Fastest";

    case "mobile":
      return "📱 Mobile";

    case "homeTheater":
      return "🎬 Home Theater";

    case "debrid":
      return "💎 Debrid";

    default:
      return "⚖️ Balanced";
  }
}

export async function getStreams(
  type: string,
  id: string,
  publicBaseUrl?: string,
  profileSettings?: any
) {
  const settings = profileSettings || getSettings();
  const [addonStreams, jackettStreams] = await Promise.all([
    getAddonStreams(
      type,
      id,
      settings.addonIds,
      settings.addonSelectionConfigured
    ),
    getJackettStreams(type, id, settings.jackett).catch((error) => {
      console.warn("Jackett search failed:", error instanceof Error ? error.message : error);
      return [];
    })
  ]);
  const streams = deduplicateStreams([...addonStreams, ...jackettStreams]);

  if (!streams.length) {
    return [];
  }

  const ranked = rankStreams(streams, settings);

  if (!ranked.length) {
    return [];
  }

  let stream = ranked[0];
  const qbittorrent = await getQBittorrentStatus();
  const passthroughKey = passthroughCacheKey(type, id, settings);
  const cachedPassthrough = passthroughSelectionCache.get(passthroughKey);
  const cachedStream =
    cachedPassthrough && cachedPassthrough.expiresAt > Date.now()
      ? ranked.find(
          (candidate) =>
            candidate.infoHash?.toLowerCase() === cachedPassthrough.infoHash
        )
      : undefined;

  if (cachedPassthrough && !cachedStream) {
    passthroughSelectionCache.delete(passthroughKey);
  }
  if (settings.playbackMethod === "torrent" && cachedStream) {
    stream = cachedStream;
    console.log("Using cached passthrough selection:", cachedStream.infoHash);
  }

  if (
    publicBaseUrl &&
    experimentalHttpEnabled &&
    qbittorrent.online &&
    settings.profile !== "debrid" &&
    settings.playbackMethod === "http" &&
    settings.midstream?.enabled === true
  ) {
    try {
      const session = createVodSession(
        `${type}:${id}:${settings.profile}`,
        ranked,
        settings.midstream
      );

      return [
        {
          name: `${getProfileName(settings.profile)} · Auto fallback`,
          title: "🍿 HTTP stream",
          url: `${publicBaseUrl}/play/${session.id}/index.m3u8`,
          behaviorHints: {
            bingeGroup: `autostream|${type}|${id}`,
            filename:
              ranked[0]?.behaviorHints?.filename ||
              ranked[0]?.title ||
              `${id}.mp4`
          }
        }
      ];
    } catch (error) {
      console.error(
        "Could not create mid-stream session; using startup fallback:",
        error
      );
    }
  }

  if (
    qbittorrent.online &&
    settings.profile !== "debrid" &&
    settings.fallback?.enabled !== false &&
    !(settings.playbackMethod === "torrent" && cachedStream)
  ) {
    const fallback = await selectFirstPlayableTorrent(
      ranked,
      settings.playbackMethod === "torrent"
        ? {
            ...settings.fallback,
            candidateTimeoutSeconds: Math.min(
              Number(settings.fallback?.candidateTimeoutSeconds || 6),
              4
            )
          }
        : settings.fallback
    );

    for (const attempt of fallback.attempts) {
      recordStreamOutcome(attempt.infoHash, attempt.success);
    }

    if (fallback.stream) {
      stream = fallback.stream;
      if (settings.playbackMethod === "torrent" && stream.infoHash) {
        passthroughSelectionCache.set(passthroughKey, {
          infoHash: stream.infoHash.toLowerCase(),
          expiresAt: Date.now() + 30 * 60 * 1000
        });
      }
    } else {
      console.warn(
        "No fallback candidate passed the startup test; using the highest-ranked stream"
      );
    }
  }

  return [
    {
      ...Object.fromEntries(
        Object.entries(stream).filter(([key]) => !key.startsWith("_autostream"))
      ),

      // What the user sees in Stremio
      name: getProfileName(settings.profile),

      title: "🍿",

      // Keep existing behavior hints for compatibility
      behaviorHints: {
        ...stream.behaviorHints
      }
    }
  ];
}
