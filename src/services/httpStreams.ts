import dns from "node:dns/promises";
import net from "node:net";

type DirectStream = {
  url?: string;
  title?: string;
  name?: string;
  behaviorHints?: {
    filename?: string;
    proxyHeaders?: {
      request?: Record<string, string>;
    };
  };
};

type HttpProbeResult = {
  bytes: number;
  contentType: string;
  filename?: string;
};

export type HttpStreamAttempt = {
  url: string;
  success: boolean;
  reason: string;
};

function privateAddress(address: string) {
  const normalized = address.toLowerCase().replace(/^::ffff:/, "");
  if (net.isIPv4(normalized)) {
    const [a = 0, b = 0] = normalized.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb")
  );
}

async function safeHttpUrl(value: string) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("unsupported stream protocol");
  }
  if (process.env.ALLOW_PRIVATE_HTTP_STREAMS !== "true") {
    const addresses = await dns.lookup(url.hostname, { all: true });
    if (!addresses.length || addresses.some(({ address }) => privateAddress(address))) {
      throw new Error("private or local stream address blocked");
    }
  }
  return url;
}

function requestHeaders(stream: DirectStream) {
  const headers = new Headers({ Range: "bytes=0-65535" });
  for (const [key, value] of Object.entries(
    stream.behaviorHints?.proxyHeaders?.request || {}
  )) {
    if (typeof value === "string") headers.set(key, value);
  }
  return headers;
}

async function readLimited(response: Response, maximumBytes: number) {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maximumBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maximumBytes - total;
      const chunk = value.subarray(0, remaining);
      chunks.push(chunk);
      total += chunk.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function firstPlaylistUri(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("#"));
}

function responseFilename(response: Response, url: URL) {
  const disposition = response.headers.get("content-disposition") || "";
  const encoded = disposition.match(/filename\*=(?:UTF-8'')?([^;]+)/i)?.[1];
  const quoted = disposition.match(/filename="([^"]+)"/i)?.[1];
  let filename = encoded || quoted;
  if (filename) {
    try {
      filename = decodeURIComponent(filename.replace(/^"|"$/g, ""));
    } catch {
      filename = filename.replace(/^"|"$/g, "");
    }
  }
  if (!filename) {
    const pathname = decodeURIComponent(url.pathname);
    const finalSegment = pathname.split("/").filter(Boolean).pop();
    if (finalSegment && /\.(mkv|mp4|avi|mov|m4v|webm|ts|m3u8)$/i.test(finalSegment)) {
      filename = finalSegment;
    }
  }
  return filename?.split(/[\\/]/).pop();
}

async function probeUrl(
  stream: DirectStream,
  value: string,
  signal: AbortSignal,
  playlistDepth = 0
): Promise<HttpProbeResult> {
  let url = await safeHttpUrl(value);
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const response = await fetch(url, {
      headers: requestHeaders(stream),
      redirect: "manual",
      signal
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("redirect has no location");
      url = await safeHttpUrl(new URL(location, url).toString());
      continue;
    }
    if (!(response.ok || response.status === 206)) {
      throw new Error(`HTTP ${response.status}`);
    }

    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    const bytes = await readLimited(response, 64 * 1024);
    const text = new TextDecoder().decode(bytes);
    const playlist =
      contentType.includes("mpegurl") ||
      /\.m3u8(?:$|\?)/i.test(url.toString()) ||
      text.trimStart().startsWith("#EXTM3U");
    if (playlist) {
      if (!text.trimStart().startsWith("#EXTM3U")) {
        throw new Error("invalid HLS playlist");
      }
      const next = firstPlaylistUri(text);
      if (!next) throw new Error("HLS playlist contains no media");
      if (playlistDepth >= 1 && /\.m3u8(?:$|\?)/i.test(next)) {
        throw new Error("nested HLS playlist is not directly playable");
      }
      const nested = await probeUrl(
        stream,
        new URL(next, url).toString(),
        signal,
        playlistDepth + 1
      );
      return {
        ...nested,
        contentType: "application/vnd.apple.mpegurl",
        filename: responseFilename(response, url) || "autostream.m3u8"
      };
    }

    if (
      contentType.includes("text/html") ||
      contentType.includes("application/json") ||
      /^\s*(?:<!doctype|<html|\{)/i.test(text)
    ) {
      throw new Error("stream returned a webpage or API error");
    }
    if (bytes.byteLength < 1024) {
      throw new Error(`only ${bytes.byteLength} media bytes returned`);
    }
    const filename = responseFilename(response, url);
    return {
      bytes: bytes.byteLength,
      contentType,
      ...(filename ? { filename } : {})
    };
  }
  throw new Error("too many redirects");
}

export async function verifyHttpStream(
  stream: DirectStream,
  timeoutMs = 4_000,
  signal?: AbortSignal
) {
  if (typeof stream.url !== "string" || !stream.url.trim()) {
    return { success: false, reason: "stream has no HTTP URL", bytes: 0 };
  }
  try {
    const probe = await probeUrl(
      stream,
      stream.url,
      signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs)
    );
    return {
      success: true,
      reason: `HTTP source delivered ${probe.bytes} verified media bytes`,
      bytes: probe.bytes,
      contentType: probe.contentType,
      filename: probe.filename
    };
  } catch (error) {
    return {
      success: false,
      reason: error instanceof Error ? error.message : "HTTP probe failed",
      bytes: 0
    };
  }
}

export async function selectFirstPlayableHttp<T extends DirectStream>(
  streams: T[],
  maximumCandidates = 4,
  timeoutMs = 4_000,
  signal?: AbortSignal
) {
  const candidates = streams
    .filter((stream) => /^https?:\/\//i.test(stream.url || ""))
    .slice(0, maximumCandidates);
  const attempts: HttpStreamAttempt[] = [];
  if (!candidates.length) return { stream: null as T | null, attempts };

  const controller = new AbortController();
  const probeSignal = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;
  const results = candidates.map(async (stream) => {
    const result = await verifyHttpStream(
      stream,
      timeoutMs,
      probeSignal
    );
    const attempt = {
      url: stream.url!,
      success: result.success,
      reason: result.reason
    };
    attempts.push(attempt);
    if (result.success) {
      controller.abort();
      return {
        ...stream,
        behaviorHints: {
          ...stream.behaviorHints,
          ...(result.filename ? { filename: result.filename } : {})
        }
      } as T;
    }
    return null;
  });

  return {
    stream: (await Promise.any(
      results.map(async (result) => {
        const stream = await result;
        if (!stream) throw new Error("candidate failed");
        return stream;
      })
    ).catch(() => null)) as T | null,
    attempts
  };
}
