# Third-party software

AutoStream uses or interoperates with the following open-source projects. They remain separate projects governed by their own licenses.

## qBittorrent

- Project: <https://www.qbittorrent.org/>
- Source: <https://github.com/qbittorrent/qBittorrent>
- License: GNU General Public License v2.0 or later

The nightly Docker Compose stack runs qBittorrent as a separate container and communicates with its Web API over Docker's internal network.

## libtorrent

- Project: <https://www.libtorrent.org/>
- Source: <https://github.com/arvidn/libtorrent>
- License: BSD 3-Clause

qBittorrent uses libtorrent as its BitTorrent engine.

## LinuxServer.io qBittorrent image

- Project: <https://docs.linuxserver.io/images/docker-qbittorrent/>
- Source: <https://github.com/linuxserver/docker-qbittorrent>

AutoStream references this independently distributed container image in its Docker Compose examples.

## Express, cors, TypeScript, and tsx

JavaScript dependencies and their licenses are listed in `package-lock.json` and their respective package distributions.
