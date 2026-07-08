import { getAddonStreams } from "./providers/addons";
import { pickBestStream } from "./services/sorter";
import { getSettings } from "./services/settings";

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

  const selected = pickBestStream(
    streams,
    settings.profile || "balanced"
  );

  if (!selected.length) {
    return [];
  }

  const stream = selected[0];

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