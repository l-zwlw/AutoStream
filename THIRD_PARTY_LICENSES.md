# Third-party software

AutoStream uses or interoperates with the following open-source projects. They remain separate projects governed by their own licenses.

## qBittorrent

- Project: <https://www.qbittorrent.org/>
- Source: <https://github.com/qbittorrent/qBittorrent>
- License: GNU General Public License v2.0 or later

The nightly Docker Compose stack runs qBittorrent as a separate container and communicates with its Web API over Docker's internal network. The published `autostream-qbittorrent` image is derived from the LinuxServer.io image and adds only the initialization script available in `docker/qbittorrent/` in this repository.

## libtorrent

- Project: <https://www.libtorrent.org/>
- Source: <https://github.com/arvidn/libtorrent>
- License: BSD 3-Clause

qBittorrent uses libtorrent as its BitTorrent engine. AutoStream 1.2 also runs
libtorrent in a separate `autostream-stream-engine` container for selective,
time-critical HTTP VOD streaming. The sidecar source is available in
`docker/stream-engine/`.

## FastAPI and Uvicorn

- FastAPI source: <https://github.com/fastapi/fastapi> (MIT)
- Uvicorn source: <https://github.com/encode/uvicorn> (BSD 3-Clause)

These projects provide the internal HTTP interface of the independently
distributed stream-engine container.

## LinuxServer.io qBittorrent image

- Project: <https://docs.linuxserver.io/images/docker-qbittorrent/>
- Source: <https://github.com/linuxserver/docker-qbittorrent>

AutoStream references this independently distributed container image in its Docker Compose examples.

The derived sidecar image retains the upstream licensing requirements and is labelled `GPL-3.0-or-later`. AutoStream's TypeScript application remains a separate MIT-licensed service.

## Jackett

- Project: <https://github.com/Jackett/Jackett>
- License: GNU General Public License v2.0
- Container: <https://docs.linuxserver.io/images/docker-jackett/>

AutoStream can optionally connect to a user-managed Jackett instance through
its Torznab API. Jackett is not bundled with or redistributed by AutoStream.

## Stremio Web and Stremio Server

- Combined container: <https://github.com/tsaridas/stremio-docker>
- Stremio Web source: <https://github.com/Stremio/stremio-web>
- Stremio Server container: <https://github.com/Stremio/server-docker>
- Stremio Web license: GNU General Public License v2.0

The standard Compose stack references `tsaridas/stremio-docker` as a separate
open-source container. It is not linked into or redistributed as part of the
MIT-licensed AutoStream application.

## Express, cors, TypeScript, and tsx

JavaScript dependencies and their licenses are listed in `package-lock.json` and their respective package distributions.
