<p align="center">
  <img src="src/public/logo.png" alt="AutoStream — Just Press Play" width="520" />
</p>

<h1 align="center">AutoStream</h1>

<p align="center">
  One Stremio result, selected automatically from all your configured addons.
</p>

<p align="center">
  <img alt="Version" src="https://img.shields.io/badge/stable-1.3.1-4dff9f" />
  <img alt="Docker" src="https://img.shields.io/badge/Docker-GHCR-2496ed" />
  <img alt="License" src="https://img.shields.io/badge/license-MIT-4dff9f" />
</p>

## What AutoStream does

AutoStream queries every enabled Stremio addon, combines their stream results, applies your global stream settings, and returns exactly one result to Stremio.

AutoStream does not bundle or preinstall content-source addons. Add only the
Stremio addon manifest URLs you choose from the dashboard.

The optional qBittorrent startup check verifies the exact requested movie or episode. Candidates race in small batches and the first torrent that delivers enough fresh data wins. AutoStream never substitutes an unverified statistical guess when verification is enabled.

## Highlights

- One clean result in Stremio
- Any standard Stremio stream addon can be added by manifest URL
- Addon names, descriptions, versions, and logos are detected automatically
- Rules-based selection using quality, size, seed, language, codec and device settings
- qBittorrent startup-fallback with configurable timeouts
- Movie collections and season packs restricted to the requested `fileIdx`
- Temporary fallback torrents and files removed automatically
- Responsive self-hosted dashboard
- One-password dashboard protection with rate limiting
- Multi-architecture Docker images for AMD64 and ARM64
- Standard Docker Compose and GHCR support
- Seekable HTTP VOD with on-demand HLS segment generation
- A dedicated libtorrent sidecar with time-critical piece deadlines
- Mid-stream fallback at the same segment timestamp
- Shared segment cache with independent sessions for multiple devices
- Global addon selection, device capabilities and stream rules
- Addon health, reliability scoring and automatic temporary suppression
- Backups, cache management and privacy-safe support reports
- Optional Jackett tracker searches through the standard Torznab API
- Optional browser player with a bundled Stremio streaming server for iPhone, iPad and desktop browsers

## How startup fallback works

```text
Stremio request
      ↓
Query enabled addons
      ↓
Rank all stream candidates
      ↓
qBittorrent tests up to three candidates together
      ├─ first exact file receiving verified data → return it
      └─ no winner → clean up and test the next batch
```

Torrent passthrough retains the bounded startup fallback. HTTP mode uses a full VOD playlist: Stremio can seek anywhere, AutoStream generates only requested segments, and a failed segment is retried from the next candidate at the same timestamp.

## HTTP VOD architecture

```text
AutoStream manifest URL
      ↓
Full seekable HLS VOD playlist
      ↓
Requested four-second segment
      ↓
libtorrent prioritizes the exact byte pieces
      ↓
FFmpeg produces fixed H.264/AAC MPEG-TS
      ↓ failure
Same timestamp is generated from candidate 2
```

Each playback request gets its own session URL. Sessions for the same content share the torrent and generated-segment cache, allowing multiple devices to watch or seek independently without duplicating work.

## Installation

Install Docker with the Compose plugin, then run:

```bash
git clone https://github.com/l-zwlw/AutoStream.git
cd AutoStream
docker compose pull
docker compose up -d
```

The standard [`docker-compose.yml`](docker-compose.yml) starts AutoStream with
its qBittorrent and streaming-engine sidecars plus an optional browser player.
Persistent configuration is stored in local folders next to the Compose file.

After the stack starts, open:

```text
http://YOUR-IP:7001
```

On first visit, create the dashboard password. Configure AutoStream under
**Settings**, then copy the manifest URL shown on the dashboard into Stremio.

### Browser and iPhone player

The Compose stack includes Stremio Web and Stremio Server as a separate,
open-source container. Open it on every device using the server's LAN address:

```text
http://YOUR-IP:7003
```

Use the same LAN URL on the Mac, iPhone and iPad. Do not use `localhost` on one
device and the LAN address on another: browsers treat them as separate sites
with separate local settings. Log in with your own Stremio account to sync the
library and Continue Watching. Keep AutoStream on **Torrent passthrough** for
this player; its Stremio Server performs browser-compatible HLS conversion.

Port 7003 is intended for the private home network. Users who deliberately
want remote access must configure their own trusted HTTPS reverse proxy and
access controls.

### Optional Jackett setup

In your existing Jackett instance, add the public or private indexers you are
allowed to use and copy its API key. In AutoStream, open
**Addons → Jackett → Configure**, enter the Jackett URL and API key,
then enable Jackett. If Jackett runs separately on the same Docker host, use
`http://host.docker.internal:9117`. A LAN URL or private HTTPS URL also works.
Do not expose Jackett directly to the public internet.

### Update

From the AutoStream directory, run:

```bash
git pull
docker compose pull
docker compose up -d
```

## Ports and storage

| Purpose | Port/path | Notes |
| --- | --- | --- |
| AutoStream dashboard and manifest | `7001` | Available on the local network |
| qBittorrent WebUI | `127.0.0.1:7002` | Host-local only |
| BitTorrent traffic | `6882/tcp` and `6882/udp` | Avoids the common host port 6881 |
| HTTP streaming-engine traffic | `6883/tcp` and `6883/udp` | Dedicated libtorrent sidecar |
| Browser player and Stremio Server | `7003` | Use the same LAN URL on every device |
| Persistent settings | `./data` | Addons, settings and password hash |
| Temporary fallback data | `./downloads` | Cleaned after each candidate test |
| qBittorrent configuration | `./qbittorrent` | Persistent internal engine settings |
| Stremio Server data | `./stremio-data` | Browser-player cache and server settings |

## Stream selection

There are no opaque stream presets. AutoStream uses the concrete settings you
choose: minimum and maximum quality, maximum size, minimum seeders, allowed
audio languages, codec preference, HDR preference, device capabilities and
addon priority. Actual startup download performance decides which verified
torrent wins. Optional debrid-aware selection is configured separately.

## Fallback settings

- **Automatic startup fallback:** enable or disable qBittorrent candidate testing
- **Seconds per candidate:** 20–30 seconds
- **Maximum candidates:** 10–20 candidates
- **Minimum verified download:** 1024–4096 KB

Candidates are tested in batches of at most three. Healthy torrents normally win before the full timeout. Successful selections are cached per movie or season for two hours, so later episodes and repeated requests can reuse the proven torrent immediately.

For multi-file torrents, every unrelated file is assigned priority `0`; only the requested `fileIdx` receives maximum priority.

## Status API

```text
GET /api/status (dashboard login required)
GET /api/qbittorrent/status (dashboard login required)
```

The dashboard uses these endpoints to display the real release version and fallback-engine state.

## Security

The dashboard and management APIs require one administrator password. Passwords are stored as a salted `scrypt` hash; session cookies are `HttpOnly`, `SameSite=Strict`, and automatically `Secure` behind HTTPS. Stremio manifest and playback routes remain public because Stremio cannot use the dashboard login.

AutoStream uses one global configuration and one manifest URL. Anyone who can
log in to the dashboard can change those settings. Existing `/p/...` manifest
URLs from older releases remain compatible and use the global settings.

The browser player is deliberately published on the LAN only by default. When
exposing either service outside the home, use a trusted HTTPS reverse proxy and
appropriate network access controls.

The qBittorrent WebUI is bound to `127.0.0.1:7002`. AutoStream communicates with it through Docker's internal network; its API is not exposed to other devices by default.

## Development

```bash
npm install
npm run check
npm start
```

Build the complete local stack:

```bash
docker compose -f docker-compose.dev.yml up -d --build
```

## License

AutoStream is released under the [MIT License](LICENSE). qBittorrent and other independently distributed components retain their own licenses; see [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).
