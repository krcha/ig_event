FROM eventzeka-node-runtime:22.22.3-bookworm-dejavu-v1
USER root
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
