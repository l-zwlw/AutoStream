# AutoStream

**Just Press Play.**

AutoStream is a self-hosted Stremio addon manager that collects streams from your configured addons and automatically returns the best stream for your selected profile.

## Features

- Beautiful self-hosted web dashboard
- Add Stremio addons by URL
- Reads addon metadata automatically
- Returns one selected stream to Stremio
- Stream profiles:
  - Balanced
  - Fastest
  - Mobile
  - Home Theater
  - Debrid
- Docker support

## Docker Compose

```yaml
services:
  autostream:
    image: ghcr.io/l-zwlw/autostream:latest
    container_name: autostream
    ports:
      - "7001:7001"
    volumes:
      - ./data:/app/data
    restart: unless-stopped