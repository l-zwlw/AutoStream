import { getAddonStreams } from "./providers/addons";
import { rankStreams } from "./services/sorter";
import { getSettings } from "./services/settings";
import {
  getQBittorrentStatus,
  selectFirstPlayableTorrent
} from "./services/qbittorrent";

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

export async function getStreams(type: string, id: string) {
  const streams = await getAddonStreams(type, id);

  if (!streams.length) {
    return [];
  }

  const settings = getSettings();

  const ranked = rankStreams(streams, settings);

  if (!ranked.length) {
    return [];
  }

  let stream = ranked[0];
  const qbittorrent = await getQBittorrentStatus();

  if (qbittorrent.online && settings.profile !== "debrid") {
    const fallback = await selectFirstPlayableTorrent(ranked);

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
