import { getAddons } from "../services/addons";

export async function getAddonStreams(type: string, id: string) {
  const addons = getAddons().filter((addon: any) => addon.enabled !== false);
  const results = await Promise.all(
    addons.map(async (addon: any) => {
      try {
      const url = `${addon.url}/stream/${type}/${id}.json`;

      console.log("Loading addon:", url);

      const response = await fetch(url, {
        signal: AbortSignal.timeout(8_000)
      });

      if (!response.ok) {
        return [];
      }

      const data: any = await response.json();

      if (data.streams) {
        return data.streams;
      }
      return [];
    } catch (error) {
      console.log("Addon failed:", addon.name || addon.url);
      return [];
    }
    })
  );

  return results.flat();
}
