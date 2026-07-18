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

const verifiedSelectionCache = new Map<
  string,
  { infoHash: string; expiresAt: number }
>();
const verificationInFlight = new Map<
  string,
  ReturnType<typeof selectFirstPlayableTorrent>
>();
const verifiedSelectionLifetimeMs = 30 * 60 * 1000;

export function verifiedSelectionKey(type: string, id: string, settings: any) {
  const selectionSettings = {
    addonIds: settings.addonIds || [],
    addonPriorities: settings.addonPriorities || {},
    device: settings.device || {},
    rules: settings.rules || {},
    fallback: settings.fallback || {}
  };

  // A season pack can behave very differently for each file. Cache only the
  // exact movie or episode and invalidate the result whenever selection
  // settings change.
  return `${type}:${id}:${JSON.stringify(selectionSettings)}`;
}

function activeVerificationKey(type: string, id: string, settings: any) {
  return `${type}:${id}`;
}

export async function getStreams(
  type: string,
  id: string,
  publicBaseUrl?: string,
  settingsOverride?: any
) {
  const settings = settingsOverride || getSettings();
  const debridMode = Boolean(
    settings.debrid?.enabled &&
    settings.debrid?.provider &&
    settings.debrid?.apiKey
  );
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

  if (settings.playbackMethod === "torrent") {
    const cacheKey = verifiedSelectionKey(type, id, settings);
    const inFlightKey = activeVerificationKey(type, id, settings);
    const cached = verifiedSelectionCache.get(cacheKey);
    const cachedStream =
      cached && cached.expiresAt > Date.now()
        ? ranked.find(
            (candidate) =>
              candidate.infoHash?.toLowerCase() === cached.infoHash
          )
        : undefined;

    if (cachedStream) {
      stream = cachedStream;
      console.log("Using verified passthrough selection:", stream.infoHash);
    } else {
      if (cached) verifiedSelectionCache.delete(cacheKey);
      const qbittorrent = await getQBittorrentStatus();
      if (qbittorrent.online && settings.fallback?.enabled !== false) {
        let verification = verificationInFlight.get(inFlightKey);
        if (!verification) {
          verification = selectFirstPlayableTorrent(ranked, settings.fallback);
          verificationInFlight.set(inFlightKey, verification);
        } else {
          console.log("Joining in-progress passthrough verification:", inFlightKey);
        }

        let fallback;
        try {
          fallback = await verification;
        } finally {
          if (verificationInFlight.get(inFlightKey) === verification) {
            verificationInFlight.delete(inFlightKey);
          }
        }
        for (const attempt of fallback.attempts) {
          if (attempt.reason !== "cancelled after another candidate succeeded") {
            recordStreamOutcome(attempt.infoHash, attempt.success);
          }
        }
        if (!fallback.stream) {
          console.warn("No torrent delivered usable video data during verification");
          return [];
        }
        stream = fallback.stream;
        if (stream.infoHash) {
          verifiedSelectionCache.set(cacheKey, {
            infoHash: stream.infoHash.toLowerCase(),
            expiresAt: Date.now() + verifiedSelectionLifetimeMs
          });
        }
      } else {
        console.warn("qBittorrent verification unavailable; using ranked passthrough result");
      }
    }

    console.log("Verified passthrough selection:", stream.title || stream.infoHash);
    return [
      {
        ...Object.fromEntries(
          Object.entries(stream).filter(([key]) => !key.startsWith("_autostream"))
        ),
        name: "AutoStream",
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
    !debridMode &&
    settings.playbackMethod === "http" &&
    settings.midstream?.enabled === true
  ) {
    try {
      const session = createVodSession(
        `${type}:${id}`,
        ranked,
        settings.midstream
      );

      return [
        {
          name: "AutoStream · Auto fallback",
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
    !debridMode &&
    settings.fallback?.enabled !== false
  ) {
    const fallback = await selectFirstPlayableTorrent(
      ranked,
      settings.fallback
    );

    for (const attempt of fallback.attempts) {
      if (attempt.reason !== "cancelled after another candidate succeeded") {
        recordStreamOutcome(attempt.infoHash, attempt.success);
      }
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
      name: "AutoStream",

      title: "🍿",

      // Keep existing behavior hints for compatibility
      behaviorHints: {
        ...stream.behaviorHints
      }
    }
  ];
}
