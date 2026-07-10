# AutoStream

**Just Press Play.**

AutoStream is a self-hosted Stremio addon manager that collects streams from configured addons and automatically returns one stream for the selected playback profile.

## Features

- Self-hosted web dashboard
- Add Stremio addons by manifest URL
- Automatic addon metadata and logos
- One selected stream in Stremio
- Balanced, Fastest, Mobile, Home Theater, and Debrid profiles
- Docker support

## Stable Docker image

```text
ghcr.io/l-zwlw/autostream:latest
```

## Nightly fallback test

The nightly image contains the experimental qBittorrent startup-fallback engine. It tests ranked torrent candidates, selects only the requested movie or episode inside packs, and cleans up temporary downloads after each test.

Clone the nightly branch:

```bash
git clone --branch agent/nightly-fallback https://github.com/l-zwlw/AutoStream.git
cd AutoStream
```

Start the nightly stack:

```bash
docker compose -f docker-compose.nightly.yml pull
docker compose -f docker-compose.nightly.yml up -d
```

Open AutoStream:

```text
http://YOUR-SERVER-IP:7001
```

The qBittorrent WebUI is bound to localhost port 7002 and is not exposed to the local network. AutoStream communicates with it through Docker's internal network.

View status and logs:

```bash
docker compose -f docker-compose.nightly.yml ps
docker compose -f docker-compose.nightly.yml logs -f autostream
```

Update to the newest nightly:

```bash
docker compose -f docker-compose.nightly.yml pull
docker compose -f docker-compose.nightly.yml up -d
```

Nightly builds are intended for testing and may change before they are merged into the stable image.

## Stremio installation

Open AutoStream's dashboard, go to **Settings**, and copy the manifest URL shown there.

## Network warning

AutoStream is designed for a trusted local network. It does not currently include user authentication. Do not expose it directly to the public internet without securing it yourself.
