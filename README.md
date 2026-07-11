<p align="center">
  <img src="src/public/logo.png" alt="AutoStream — Just Press Play" width="520" />
</p>

<h1 align="center">AutoStream</h1>

<p align="center">
  One Stremio result, selected automatically from all your configured addons.
</p>

<p align="center">
  <img alt="Version" src="https://img.shields.io/badge/stable-1.2.0-4dff9f" />
  <img alt="Docker" src="https://img.shields.io/badge/Docker-GHCR-2496ed" />
  <img alt="License" src="https://img.shields.io/badge/license-MIT-4dff9f" />
</p>

## What AutoStream does

AutoStream queries every enabled Stremio addon, combines their stream results, applies the selected playback profile, and returns exactly one result to Stremio.

The optional qBittorrent startup check verifies the exact requested movie or episode. It has a six-second total budget; if verification cannot finish in time, AutoStream immediately returns the highest-ranked result instead of leaving Stremio loading.

## Highlights

- One clean result in Stremio
- Any standard Stremio stream addon can be added by manifest URL
- Addon names, descriptions, versions, and logos are detected automatically
- Balanced, Fastest, Mobile, Home Theater, and Debrid profiles
- qBittorrent startup-fallback with configurable timeouts
- Movie collections and season packs restricted to the requested `fileIdx`
- Temporary fallback torrents and files removed automatically
- Responsive self-hosted dashboard
- Household profiles with individual settings and Stremio install URLs
- One-password dashboard protection with rate limiting
- Multi-architecture Docker images for AMD64 and ARM64
- Docker, ZimaOS, and GHCR support
- Seekable HTTP VOD with on-demand HLS segment generation
- A dedicated libtorrent sidecar with time-critical piece deadlines
- Mid-stream fallback at the same segment timestamp
- Shared segment cache with independent sessions for multiple devices
- Per-profile addon selection, device capabilities and stream rules
- Addon health, reliability scoring and automatic temporary suppression
- Backups, cache management and privacy-safe support reports

## How startup fallback works

```text
Stremio request
      ↓
Query enabled addons
      ↓
Rank all stream candidates
      ↓
qBittorrent tests candidate 1
      ├─ exact file receives data → return it
      └─ timeout or failure → clean up and try candidate 2
```

Torrent passthrough retains the bounded startup fallback. HTTP mode uses a full VOD playlist: Stremio can seek anywhere, AutoStream generates only requested segments, and a failed segment is retried from the next candidate at the same timestamp.

## HTTP VOD architecture

```text
Stremio profile URL
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

Create a custom app and paste the contents of [`docker-compose.yml`](docker-compose.yml). It is a normal Compose stack with three services, deliberately ordered with AutoStream first, followed by its qBittorrent and streaming-engine sidecars.

After the stack starts, open:

```text
http://YOUR-IP:7001
```

On first visit, create the dashboard password. Then open **Profiles**, create a profile for each viewer, configure it under **Settings**, and install its personal manifest URL in Stremio.

### Update

Pull and recreate the stack from the ZimaOS interface, or run:

```bash
docker compose pull
docker compose up -d
```

## Docker Compose from Git

```bash
git clone https://github.com/l-zwlw/AutoStream.git
cd AutoStream
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
| Persistent settings | `./data` | Addons, profiles, settings and password hash |
| Temporary fallback data | `./downloads` | Cleaned after each candidate test |
| qBittorrent configuration | `./qbittorrent` | Persistent internal engine settings |

## Playback profiles

| Profile | Intended behavior |
| --- | --- |
| Balanced | Good quality, reasonable size, and healthy availability |
| Fastest | Smaller files and strong availability |
| Mobile | Bandwidth-friendly 720p/1080p results |
| Home Theater | 4K, HDR, REMUX, and premium audio bonuses |
| Debrid | Highest-quality cached/debrid results returned by configured addons |

The Debrid profile scores streams already provided by debrid-enabled addons. AutoStream does not currently resolve debrid links itself.

## Fallback settings

- **Automatic startup fallback:** enable or disable qBittorrent candidate testing
- **Seconds per candidate:** 3–8 seconds
- **Maximum candidates:** 1–10 candidates
- **Minimum verified download:** 64–4096 KB

For multi-file torrents, every unrelated file is assigned priority `0`; only the requested `fileIdx` receives maximum priority.

## Status API

```text
GET /api/status (dashboard login required)
GET /api/qbittorrent/status (dashboard login required)
```

The dashboard uses these endpoints to display the real release version and fallback-engine state.

## Security

The dashboard and management APIs require one administrator password. Passwords are stored as a salted `scrypt` hash; session cookies are `HttpOnly`, `SameSite=Strict`, and automatically `Secure` behind HTTPS. Stremio manifest and playback routes remain public because Stremio cannot use the dashboard login.

Viewer profiles are preference profiles, not separate security accounts. Anyone who can log in to the dashboard can manage every profile. When exposing AutoStream outside the home, keep using a trusted HTTPS reverse proxy and appropriate network access controls.

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
