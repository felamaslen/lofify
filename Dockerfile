# syntax=docker/dockerfile:1.7

# Git commit the image is built from. Threaded into the web bundle (VITE_GIT_SHA)
# and the backend runtime (GIT_SHA) so Query.isUpdateAvailable can flag clients
# running an older build. Pass `--build-arg GIT_SHA=$(git rev-parse HEAD)`.
ARG GIT_SHA=dev

# ---------- base ----------
FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

# ---------- deps ----------
FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* tsconfig.json tsconfig.build.json ./
COPY packages ./packages
COPY patches ./patches
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile || pnpm install

# ---------- build (web) ----------
FROM deps AS build
ARG GIT_SHA
ENV VITE_GIT_SHA=$GIT_SHA
RUN pnpm --filter ./packages/web build

# ---------- runtime ----------
FROM node:24-bookworm-slim AS backend
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

# ffmpeg 8.1.1 (LGPL static builds from BtbN — Debian Bookworm only ships 5.x). When bumping versions, pick a matching `autobuild-YYYY-MM-DD-HH-MM` release at https://github.com/BtbN/FFmpeg-Builds/releases and refresh both file names + SHA256s.
ARG TARGETARCH
ARG FFMPEG_BUILD=autobuild-2026-05-26-13-56
ARG FFMPEG_FILE_AMD64=ffmpeg-n8.1.1-8-gb21e00eda5-linux64-lgpl-8.1.tar.xz
ARG FFMPEG_SHA256_AMD64=d07266cd9f743d8c09bfaf2cdda47b767d1183573ff3e03262e449028219cbda
ARG FFMPEG_FILE_ARM64=ffmpeg-n8.1.1-8-gb21e00eda5-linuxarm64-lgpl-8.1.tar.xz
ARG FFMPEG_SHA256_ARM64=32efd99c91849269055649487bd807bcbd6a746975ca2660c1e3d327a2068bb5

RUN corepack enable \
 && apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils \
 && rm -rf /var/lib/apt/lists/* \
 && case "$TARGETARCH" in \
      amd64) FFMPEG_FILE="$FFMPEG_FILE_AMD64"; FFMPEG_SHA256="$FFMPEG_SHA256_AMD64" ;; \
      arm64) FFMPEG_FILE="$FFMPEG_FILE_ARM64"; FFMPEG_SHA256="$FFMPEG_SHA256_ARM64" ;; \
      *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac \
 && curl -fsSL -o /tmp/ffmpeg.tar.xz \
      "https://github.com/BtbN/FFmpeg-Builds/releases/download/${FFMPEG_BUILD}/${FFMPEG_FILE}" \
 && echo "${FFMPEG_SHA256}  /tmp/ffmpeg.tar.xz" | sha256sum -c - \
 && tar -xJf /tmp/ffmpeg.tar.xz -C /tmp \
 && mv /tmp/ffmpeg-*/bin/ffmpeg /tmp/ffmpeg-*/bin/ffprobe /usr/local/bin/ \
 && rm -rf /tmp/ffmpeg.tar.xz /tmp/ffmpeg-* \
 && apt-get purge -y --auto-remove curl xz-utils

WORKDIR /app
COPY --from=build /app /app
ARG GIT_SHA
ENV GIT_SHA=$GIT_SHA
ENV NODE_ENV=production
EXPOSE 4000
CMD ["pnpm", "--filter", "./packages/backend", "start"]
