import { getAddonStreams } from "./providers/addons";
import { rankStreams } from "./services/sorter";
import { getSettings } from "./services/settings";
import {
  getQBittorrentStatus,
  selectFirstPlayableTorrent
} from "./services/qbittorrent";
import { createVodSession } from "./services/vodStreaming";
import { deduplicateStreams } from "./services/dedupe";
import { recordAddonResult, recordStreamOutcome } from "./services/health";
import { getJackettStreams } from "./providers/jackett";

const experimentalHttpEnabled =
  process.env.ENABLE_EXPERIMENTAL_HTTP === "true";

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
  const loadJackettStreams = async () => {
    const startedAt = Date.now();
    try {
      const results = await getJackettStreams(type, id, settings.jackett);
      if (settings.jackett?.enabled) {
        recordAddonResult("jackett", {
          success: true,
          latencyMs: Date.now() - startedAt,
          streams: results.length
        });
      }
      return results;
    } catch (error) {
      if (settings.jackett?.enabled) {
        recordAddonResult("jackett", {
          success: false,
          latencyMs: Date.now() - startedAt,
          streams: 0,
          error: error instanceof Error ? error.message : "Jackett search failed"
        });
      }
      console.warn("Jackett search failed:", error instanceof Error ? error.message : error);
      return [];
    }
  };
  const sourceResults: any[][] = [];
  let resolveFirstSource: (() => void) | undefined;
  const firstSource = new Promise<void>((resolve) => {
    resolveFirstSource = resolve;
  });
  const sourceTasks = [
    getAddonStreams(
      type,
      id,
      settings.addonIds,
      settings.addonSelectionConfigured
    ),
    loadJackettStreams()
  ].map(async (task, index) => {
    const result = await task;
    sourceResults[index] = result;
    if (result.length) resolveFirstSource?.();
    return result;
  });

  // Merge fast sources, but never let a slow Jackett/indexer query hold the
  // Stremio screen open. Late Jackett results still populate its cache.
  await Promise.race([
    Promise.all(sourceTasks),
    firstSource.then(() => new Promise((resolve) => setTimeout(resolve, 750))),
    new Promise((resolve) => setTimeout(resolve, 2_500))
  ]);
  const [addonStreams = [], jackettStreams = []] = sourceResults;
  const streams = deduplicateStreams([...addonStreams, ...jackettStreams]);

  if (!streams.length) {
    return [];
  }

  const ranked = rankStreams(streams, settings);

  if (!ranked.length) {
    return [];
  }

  let stream = ranked[0];

  // Torrent passthrough must stay fast. Stremio is the torrent client in this
  // mode, so waiting for qBittorrent to add, probe and delete several magnets
  // adds seconds of latency without reliably predicting Stremio playback.
  // The globally ranked result already favours real availability signals such
  // as seeders and a practical file size.
  if (settings.playbackMethod === "torrent") {
    console.log("Fast passthrough selection:", stream.title || stream.infoHash);
    return [
      {
        ...Object.fromEntries(
          Object.entries(stream).filter(([key]) => !key.startsWith("_autostream"))
        ),
        name: getProfileName(settings.profile),
        title: "🍿",
        behaviorHints: {
          ...stream.behaviorHints
        }
      }
    ];
  }

  const qbittorrent = await getQBittorrentStatus();

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
    settings.fallback?.enabled !== false
  ) {
    const fallback = await selectFirstPlayableTorrent(
      ranked,
      settings.fallback
    );

    for (const attempt of fallback.attempts) {
      recordStreamOutcome(attempt.infoHash, attempt.success);
    }

    if (fallback.stream) {
      stream = fallback.stream;
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
