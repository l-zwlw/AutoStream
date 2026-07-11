function normalizedFilename(stream: any) {
  return String(stream.behaviorHints?.filename || stream.title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function deduplicateStreams(streams: any[]) {
  const seen = new Set<string>();
  return streams.filter((stream) => {
    const hash = typeof stream.infoHash === "string" ? stream.infoHash.toLowerCase() : "";
    const fileIndex = Number.isInteger(stream.fileIdx) ? stream.fileIdx : "";
    const url = typeof stream.url === "string" ? stream.url : "";
    const filename = normalizedFilename(stream);
    const key = hash
      ? `torrent:${hash}:${fileIndex}`
      : url
        ? `url:${url}`
        : `file:${filename}`;
    if (!key || key === "file:") return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
