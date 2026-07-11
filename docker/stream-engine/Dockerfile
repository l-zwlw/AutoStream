FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    python3 \
    python3-libtorrent \
    python3-pip \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN pip3 install --break-system-packages --no-cache-dir fastapi==0.116.1 uvicorn==0.35.0

WORKDIR /engine
COPY docker/stream-engine/engine.py /engine/engine.py

EXPOSE 7010
CMD ["python3", "-m", "uvicorn", "engine:app", "--host", "0.0.0.0", "--port", "7010"]
