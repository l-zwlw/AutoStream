<p align="center">
  <img src="src/public/logo.png" alt="AutoStream — Just Press Play" width="520" />
</p>

<h1 align="center">AutoStream</h1>

<p align="center">
  One Stremio result, selected automatically from all your configured addons.
</p>

<p align="center">
  <img alt="Version" src="https://img.shields.io/badge/nightly-1.1.0-7857ff" />
  <img alt="Docker" src="https://img.shields.io/badge/Docker-GHCR-2496ed" />
  <img alt="License" src="https://img.shields.io/badge/license-MIT-4dff9f" />
</p>

> [!IMPORTANT]
> AutoStream 1.1 is currently a nightly preview. The startup-fallback engine is ready for real-world testing but has not yet been promoted to `latest`.

## What AutoStream does

AutoStream queries every enabled Stremio addon, combines their stream results, applies the selected playback profile, and returns exactly one result to Stremio.

The 1.1 nightly adds an optional qBittorrent startup check. Before returning a torrent, AutoStream verifies that the exact requested movie or episode receives real download data. Dead candidates are removed and the next ranked candidate is tried automatically.

## Highlights

- One clean result in Stremio
- Any standard Stremio stream addon can be added by manifest URL
- Addon names, descriptions, versions, and logos are detected automatically
- Balanced, Fastest, Mobile, Home Theater, and Debrid profiles
- qBittorrent startup-fallback with configurable timeouts
- Movie collections and season packs restricted to the requested `fileIdx`
- Temporary fallback torrents and files removed automatically
- Responsive self-hosted dashboard
- Multi-architecture Docker images for AMD64 and ARM64
- Docker, ZimaOS, and GHCR support

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

AutoStream currently performs fallback before playback begins. Seamless switching during an already playing video is not part of this nightly.

## ZimaOS nightly installation

Create a custom app and paste the contents of [`docker-compose.zima.yml`](docker-compose.zima.yml). It contains only two normal services, deliberately ordered with AutoStream first and its dedicated qBittorrent sidecar second.

After the stack starts, open:

```text
http://YOUR-ZIMAOS-IP:7001
```

Then open **Settings**, configure the playback profile and fallback preferences, and copy the generated Stremio manifest URL.

### Update the nightly

Pull and recreate the stack from the ZimaOS interface, or run:

```bash
docker compose -f docker-compose.zima.yml pull
docker compose -f docker-compose.zima.yml up -d
```

## Docker Compose from Git

```bash
git clone --branch agent/nightly-fallback https://github.com/l-zwlw/AutoStream.git
cd AutoStream
docker compose -f docker-compose.nightly.yml pull
docker compose -f docker-compose.nightly.yml up -d
```

## Ports and storage

| Purpose | Port/path | Notes |
| --- | --- | --- |
| AutoStream dashboard and manifest | `7001` | Available on the local network |
| qBittorrent WebUI | `127.0.0.1:7002` | Host-local only |
| BitTorrent traffic | `6882/tcp` and `6882/udp` | Avoids the common host port 6881 |
| Persistent settings | `./data` | Addons and AutoStream settings |
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
- **Seconds per candidate:** 5–60 seconds
- **Maximum candidates:** 1–10 candidates
- **Minimum verified download:** 64–4096 KB

For multi-file torrents, every unrelated file is assigned priority `0`; only the requested `fileIdx` receives maximum priority.

## Status API

```text
GET /api/status
GET /api/qbittorrent/status
```

The dashboard uses these endpoints to display the real release version and fallback-engine state.

## Security

AutoStream is intended for a trusted local network and does not currently include user authentication. Do not expose port 7001 directly to the public internet without adding your own access controls.

The qBittorrent WebUI is bound to `127.0.0.1:7002`. AutoStream communicates with it through Docker's internal network; its API is not exposed to other devices by default.

## Development

```bash
npm install
npm run check
npm start
```

Build the complete local stack:

```bash
docker compose up -d --build
```

## License

AutoStream is released under the [MIT License](LICENSE). qBittorrent and other independently distributed components retain their own licenses; see [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).
