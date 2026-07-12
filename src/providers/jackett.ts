import { XMLParser } from "fast-xml-parser";
import parseTorrent from "parse-torrent";

export type JackettSettings = {
  enabled?: boolean;
  url?: string;
  apiKey?: string;
  indexer?: string;
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseTagValue: false,
  trimValues: true
});

function list<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function safeBaseUrl(value?: string) {
  if (!value?.trim()) throw new Error("Jackett URL required");
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error("Jackett URL must use HTTP or HTTPS");
  return url.toString().replace(/\/$/, "");
}

function attribute(item: any, name: string) {
  return list(item?.["torznab:attr"] || item?.attr)
    .find((entry: any) => entry?.name === name)?.value;
}

function quality(title: string) {
  if (/2160p|\b4k\b/i.test(title)) return "4k";
  if (/1080p/i.test(title)) return "1080p";
  if (/720p/i.test(title)) return "720p";
  return "unknown";
}

function formatSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "unknown size";
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}

function exactEpisode(title: string, season?: number, episode?: number) {
  if (!season || !episode) return true;
  const token = `s${String(season).padStart(2, "0")}e${String(episode).padStart(2, "0")}`;
  return title.toLowerCase().includes(token);
}

function matchesTitle(title: string, requiredTitle?: string) {
  if (!requiredTitle) return true;
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return normalize(title).includes(normalize(requiredTitle));
}

async function torrentIdentity(item: any) {
  const magnet = String(attribute(item, "magneturl") || "");
  const directHash = String(attribute(item, "infohash") || "").toLowerCase();
  if (/^[a-f0-9]{40}$/.test(directHash)) {
    return { infoHash: directHash, sources: [] as string[] };
  }

  if (magnet.startsWith("magnet:")) {
    const parsed: any = await parseTorrent(magnet);
    return {
      infoHash: String(parsed.infoHash || "").toLowerCase(),
      sources: list(parsed.announce).map((tracker) => `tracker:${tracker}`)
    };
  }

  const link = String(item?.link || item?.guid?.["#text"] || item?.guid || "");
  if (!/^https?:\/\//i.test(link)) return undefined;
  const response = await fetch(link, { signal: AbortSignal.timeout(8_000) });
  if (!response.ok) return undefined;
  const parsed: any = await parseTorrent(Buffer.from(await response.arrayBuffer()));
  return {
    infoHash: String(parsed.infoHash || "").toLowerCase(),
    sources: list(parsed.announce).map((tracker) => `tracker:${tracker}`)
  };
}

export async function getJackettStreams(type: string, id: string, settings: JackettSettings = {}) {
  if (!settings.enabled || !settings.apiKey || !settings.url) return [];
  const [imdbId, seasonText, episodeText] = id.split(":");
  if (!/^tt\d+$/.test(imdbId || "")) return [];
  const season = Number(seasonText) || undefined;
  const episode = Number(episodeText) || undefined;
  const baseUrl = safeBaseUrl(settings.url);
  const indexer = encodeURIComponent(settings.indexer?.trim() || "all");
  const endpoint = `${baseUrl}/api/v2.0/indexers/${indexer}/results/torznab/api`;
  const search = async (params: Record<string, string>) => {
    const query = new URL(endpoint);
    query.searchParams.set("apikey", settings.apiKey!);
    for (const [name, value] of Object.entries(params)) query.searchParams.set(name, value);
    const response = await fetch(query, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`Jackett returned HTTP ${response.status}`);
    const document: any = parser.parse(await response.text());
    return list(document?.rss?.channel?.item);
  };

  let items: any[] = [];
  let requiredTitle = "";
  try {
    items = await search({
      t: type === "series" ? "tvsearch" : "movie",
      imdbid: imdbId!,
      ...(season ? { season: String(season) } : {}),
      ...(episode ? { ep: String(episode) } : {})
    });
  } catch {
    // Many Jackett indexers only support text search. The fallback below
    // resolves the title and retries without relying on IMDb support.
  }

  if (items.length === 0) {
    const metadataResponse = await fetch(
      `https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`,
      { signal: AbortSignal.timeout(8_000) }
    );
    if (metadataResponse.ok) {
      const metadata: any = await metadataResponse.json();
      const name = String(metadata?.meta?.name || "")
        .replace(/:/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (name) {
        requiredTitle = name;
        const episodeToken = season && episode
          ? ` S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`
          : "";
        items = await search({
          t: type === "series" ? "tvsearch" : "search",
          q: `${name}${episodeToken}`,
          ...(season ? { season: String(season) } : {}),
          ...(episode ? { ep: String(episode) } : {})
        });
      }
    }
  }

  items = items
    .filter((item: any) => {
      const title = String(item?.title || "");
      return exactEpisode(title, season, episode) && matchesTitle(title, requiredTitle);
    })
    .slice(0, 30);
  const resolved = await Promise.all(items.map(async (item: any) => {
    try {
      const identity = await torrentIdentity(item);
      if (!identity || !/^[a-f0-9]{40}$/.test(identity.infoHash)) return undefined;
      const title = String(item.title || "Jackett result");
      const seeders = Number(attribute(item, "seeders") || 0);
      const size = Number(item.size || attribute(item, "size") || 0);
      const tracker = String(attribute(item, "tracker") || item.jackettindexer?.["#text"] || item.jackettindexer || "Jackett");
      return {
        name: `Jackett\n${quality(title)}`,
        title: `${title}\n👤 ${seeders} 💾 ${formatSize(size)} ⚙️ ${tracker}`,
        infoHash: identity.infoHash,
        sources: identity.sources,
        behaviorHints: { filename: title },
        _autostreamAddonId: "jackett",
        _autostreamAddonName: "Jackett"
      };
    } catch {
      return undefined;
    }
  }));
  return resolved.filter(Boolean);
}

export async function getJackettStatus(settings: JackettSettings = {}) {
  if (!settings.enabled) return { enabled: false, online: false, configured: Boolean(settings.apiKey) };
  if (!settings.apiKey || !settings.url) return { enabled: true, online: false, configured: false, error: "URL and API key required" };
  try {
    const baseUrl = safeBaseUrl(settings.url);
    const response = await fetch(`${baseUrl}/api/v2.0/indexers/all/results/torznab/api?apikey=${encodeURIComponent(settings.apiKey)}&t=indexers&configured=true`, { signal: AbortSignal.timeout(8_000) });
    return { enabled: true, configured: true, online: response.ok, error: response.ok ? null : `HTTP ${response.status}` };
  } catch (error) {
    return { enabled: true, configured: true, online: false, error: error instanceof Error ? error.message : "Jackett unavailable" };
  }
}
