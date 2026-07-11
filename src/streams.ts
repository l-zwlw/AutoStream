import { getAddonStreams } from "./providers/addons";
import { rankStreams } from "./services/sorter";
import { getSettings } from "./services/settings";
import {
  getQBittorrentStatus,
  selectFirstPlayableTorrent
} from "./services/qbittorrent";
import { createStreamingSession } from "./services/streaming";

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
  const streams = await getAddonStreams(type, id);

  if (!streams.length) {
    return [];
  }

  const settings = profileSettings || getSettings();

  const ranked = rankStreams(streams, settings);

  if (!ranked.length) {
    return [];
  }

  let stream = ranked[0];
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
      const session = await createStreamingSession(
        ranked,
        settings.fallback,
        settings.midstream,
        `${type}:${id}`
      );

      return [
        {
          name: `${getProfileName(settings.profile)} · Auto fallback`,
          title: "🍿 HTTP stream",
          url: `${publicBaseUrl}/play/${session.id}/index.m3u8`,
          behaviorHints: {
            bingeGroup: `autostream|${type}|${id}`
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
      ...stream,

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
