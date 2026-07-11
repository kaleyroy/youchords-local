FROM python:3.10-slim AS nnls-builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libboost-dev \
    vamp-plugin-sdk \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY third_party/nnls-chroma/ ./
RUN make \
    VAMP_SDK_DIR=/usr/include/vamp-sdk \
    CFLAGS="-O3 -ftree-vectorize -ffast-math -I/usr/include/vamp-sdk -Wall -fPIC" \
    CXXFLAGS="-O3 -ftree-vectorize -ffast-math -I/usr/include/vamp-sdk -Wall -fPIC" \
    LDFLAGS="-shared -Wl,-soname=nnls-chroma.so -lvamp-sdk -Wl,--version-script=vamp-plugin.map"

FROM python:3.10-slim AS python-builder
WORKDIR /build
COPY requirements.txt .
RUN apt-get update && apt-get install -y --no-install-recommends build-essential \
    && python -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir --upgrade pip setuptools wheel \
    && /opt/venv/bin/pip install --no-cache-dir numpy==1.26.4 \
    && /opt/venv/bin/pip install --no-cache-dir --no-build-isolation -r requirements.txt \
    && rm -rf /var/lib/apt/lists/*

FROM python:3.10-slim

ARG SONIC_ANNOTATOR_URL=https://github.com/sonic-visualiser/sonic-annotator/releases/download/sonic-annotator-1.7/sonic-annotator-1.7.0-linux64-static.tar.gz
ARG SONIC_ANNOTATOR_SHA256=ec7838368aa6b20a039d04ebd5d91f4efd26e9c79f713b70843e35880151b919

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    ffmpeg \
    libsndfile1 \
    libvamp-sdk2v5 \
    nodejs \
    && rm -rf /var/lib/apt/lists/*

COPY --from=python-builder /opt/venv /opt/venv
WORKDIR /app

RUN curl --fail --location --retry 4 --retry-delay 2 "$SONIC_ANNOTATOR_URL" -o /tmp/sonic.tar.gz \
    && echo "$SONIC_ANNOTATOR_SHA256  /tmp/sonic.tar.gz" | sha256sum --check - \
    && mkdir -p /app/engine/sonic-annotator \
    && tar -xzf /tmp/sonic.tar.gz --strip-components=1 -C /app/engine/sonic-annotator \
    && rm /tmp/sonic.tar.gz \
    && chmod +x /app/engine/sonic-annotator/sonic-annotator \
    && cd /app/engine/sonic-annotator \
    && ./sonic-annotator --appimage-extract >/dev/null \
    && chmod +x /app/engine/sonic-annotator/squashfs-root/AppRun

COPY --from=nnls-builder /src/nnls-chroma.so /app/engine/vamp_plugins/nnls-chroma.so
COPY --from=nnls-builder /src/nnls-chroma.cat /app/engine/vamp_plugins/nnls-chroma.cat
COPY --from=nnls-builder /src/nnls-chroma.n3 /app/engine/vamp_plugins/nnls-chroma.n3
COPY --from=nnls-builder /src/COPYING /app/engine/vamp_plugins/COPYING
COPY --from=nnls-builder /src/CITATION /app/engine/vamp_plugins/CITATION
COPY --from=nnls-builder /src/README /app/engine/vamp_plugins/README

COPY app.py ./
COPY engine/ ./engine/
RUN mkdir -p /app/engine/temp /app/engine/output/chords /data/results /data/uploads

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH=/opt/venv/bin:$PATH \
    VAMP_PATH=/app/engine/vamp_plugins \
    YOUCHORDS_DATA_DIR=/data \
    YOUCHORDS_REGULAR_ENGINE=chordino

EXPOSE 8765
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8765", "--workers", "1"]
