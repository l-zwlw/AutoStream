export async function getStremioWebStatus() {
  const url = process.env.STREMIO_WEB_URL || "";

  if (!url) {
    return { configured: false, online: false };
  }

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(3_000)
    });
    return {
      configured: true,
      online: response.ok,
      status: response.status
    };
  } catch (error) {
    return {
      configured: true,
      online: false,
      error: error instanceof Error ? error.message : "Browser player unavailable"
    };
  }
}
