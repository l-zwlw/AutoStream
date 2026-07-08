import { getAddons } from "../services/addons";

export async function getAddonStreams(type: string, id: string) {
  const addons = getAddons();

  let streams: any[] = [];

  for (const addon of addons) {
    if (addon.enabled === false) {
      continue;
    }

    try {
      const url = `${addon.url}/stream/${type}/${id}.json`;

      console.log("Loading addon:", url);

      const response = await fetch(url);

      if (!response.ok) {
        continue;
      }

      const data: any = await response.json();

      if (data.streams) {
        streams.push(...data.streams);
      }
    } catch (error) {
      console.log("Addon failed:", addon.name || addon.url);
    }
  }

  return streams;
}
