import { getAddonStreams } from "./providers/addons";
import { rankStreams } from "./services/sorter";
import { getSettings } from "./services/settings";
import {
  getQBittorrentStatus,
  selectFirstPlayableTorrent,
  torrentSourcesWithDefaults
} from "./services/qbittorrent";
import { createVodSession } from "./services/vodStreaming";
import { deduplicateStreams } from "./services/dedupe";
import { recordAddonResult, recordStreamOutcome } from "./services/health";
import { getJackettStreams } from "./providers/jackett";
import { selectFirstPlayableHttp } from "./services/httpStreams";

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
// Recheck regularly: swarm health can change quickly and a once-fast torrent
// must not remain sticky for half an hour.
const verifiedSelectionLifetimeMs = 5 * 60 * 1000;

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

function presentDirectStream(stream: any) {
  return {
    ...Object.fromEntries(
      Object.entries(stream).filter(([key]) => !key.startsWith("_autostream"))
    ),
    name: "AutoStream",
    title: "🍿 HTTP",
    behaviorHints: {
      ...stream.behaviorHints
    }
  };
}

function presentTorrentStream(stream: any) {
  return {
    ...Object.fromEntries(
      Object.entries(stream).filter(([key]) => !key.startsWith("_autostream"))
    ),
    sources: torrentSourcesWithDefaults(stream.sources),
    name: "AutoStream",
    title: "🍿",
    behaviorHints: {
      ...stream.behaviorHints
    }
  };
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

  // Jackett often needs longer than a hosted Stremio addon because it queries
  // multiple indexers. When the user enabled it, give it a real opportunity
  // to join the global candidate pool instead of returning as soon as
  // Torrentio answers.
  await (settings.jackett?.enabled
    ? Promise.race([
        Promise.all(sourceTasks),
        // Jackett keeps source priority, but the Stremio stream screen may not
        // be blocked for an entire indexer cycle. Late results remain cached.
        new Promise((resolve) => setTimeout(resolve, 2_000))
      ])
    : Promise.race([
        Promise.all(sourceTasks),
        firstSource.then(() => new Promise((resolve) => setTimeout(resolve, 750))),
        new Promise((resolve) => setTimeout(resolve, 2_500))
      ]));
  const [addonStreams = [], jackettStreams = []] = sourceResults;
  const streams = deduplicateStreams([...addonStreams, ...jackettStreams]);

  if (!streams.length) {
    return [];
  }

  const ranked = rankStreams(streams, settings);

  if (!ranked.length) {
    return [];
  }

  const directCandidates = ranked.filter(
    (candidate) => typeof candidate.url === "string"
  );
  const torrentCandidates = ranked.filter(
    (candidate) =>
      typeof candidate.infoHash === "string" &&
      /^[a-fA-F0-9]{40}$/.test(candidate.infoHash)
  );
  let stream = torrentCandidates[0];

  if (settings.playbackMethod === "torrent") {
    const raceController = new AbortController();
    const directPromise = selectFirstPlayableHttp(
      directCandidates,
      4,
      4_000,
      raceController.signal
    );
    const cacheKey = verifiedSelectionKey(type, id, settings);
    const inFlightKey = activeVerificationKey(type, id, settings);
    const cached = verifiedSelectionCache.get(cacheKey);
    const cachedStream =
      cached && cached.expiresAt > Date.now()
        ? torrentCandidates.find(
            (candidate) =>
              candidate.infoHash?.toLowerCase() === cached.infoHash
          )
        : undefined;

    if (cachedStream) {
      stream = cachedStream;
      raceController.abort();
      console.log("Using verified passthrough selection:", stream.infoHash);
    } else {
      if (cached) verifiedSelectionCache.delete(cacheKey);
      const qbittorrent = await getQBittorrentStatus();
      if (qbittorrent.online && settings.fallback?.enabled !== false) {
        let verification = verificationInFlight.get(inFlightKey);
        if (!verification) {
          verification = selectFirstPlayableTorrent(
            torrentCandidates,
            settings.fallback,
            directCandidates.length ? raceController.signal : undefined
          );
          if (!directCandidates.length) {
            verificationInFlight.set(inFlightKey, verification);
          }
        } else {
          console.log("Joining in-progress passthrough verification:", inFlightKey);
        }

        const torrentRace = verification.then((fallback) => {
          if (!fallback.stream) throw new Error("no torrent passed verification");
          return { kind: "torrent" as const, stream: fallback.stream, fallback };
        });
        const httpRace = directPromise.then((direct) => {
          for (const attempt of direct.attempts) {
            console.log(
              `HTTP candidate ${attempt.success ? "accepted" : "rejected"}:`,
              attempt.url,
              `(${attempt.reason})`
            );
          }
          if (!direct.stream) throw new Error("no HTTP stream passed verification");
          return { kind: "http" as const, stream: direct.stream };
        });

        const winner = await Promise.any([torrentRace, httpRace]).catch(
          () => null
        );
        raceController.abort();
        if (verificationInFlight.get(inFlightKey) === verification) {
          verificationInFlight.delete(inFlightKey);
        }

        if (!winner) {
          console.warn("No HTTP stream or torrent passed startup verification");
          return [];
        }
        if (winner.kind === "http") {
          return [presentDirectStream(winner.stream)];
        }

        for (const attempt of winner.fallback.attempts) {
          if (
            attempt.reason !== "cancelled after another candidate succeeded"
          ) {
            recordStreamOutcome(attempt.infoHash, attempt.success);
          }
        }
        stream = winner.stream;
        if (stream.infoHash) {
          verifiedSelectionCache.set(cacheKey, {
            infoHash: stream.infoHash.toLowerCase(),
            expiresAt: Date.now() + verifiedSelectionLifetimeMs
          });
        }
      } else {
        const direct = await directPromise;
        raceController.abort();
        if (direct.stream) return [presentDirectStream(direct.stream)];
        if (!stream) {
          console.warn("No verified HTTP stream and no torrent is available");
          return [];
        }
        console.warn(
          "qBittorrent verification unavailable; using ranked passthrough result"
        );
      }
    }

    console.log("Verified passthrough selection:", stream.title || stream.infoHash);
    return [presentTorrentStream(stream)];
  }

  const directVerification = await selectFirstPlayableHttp(directCandidates);
  if (directVerification.stream) {
    return [presentDirectStream(directVerification.stream)];
  }
  if (!torrentCandidates.length) {
    console.warn("No direct HTTP stream or torrent passed validation");
    return [];
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
        torrentCandidates,
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
              torrentCandidates[0]?.behaviorHints?.filename ||
              torrentCandidates[0]?.title ||
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
      torrentCandidates,
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
