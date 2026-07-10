FROM lscr.io/linuxserver/qbittorrent:latest

LABEL org.opencontainers.image.source="https://github.com/l-zwlw/AutoStream"
LABEL org.opencontainers.image.description="AutoStream qBittorrent sidecar"
LABEL org.opencontainers.image.licenses="GPL-3.0-or-later"

COPY docker/qbittorrent/10-autostream-config.sh /custom-cont-init.d/10-autostream-config.sh

RUN chmod 0755 /custom-cont-init.d/10-autostream-config.sh
