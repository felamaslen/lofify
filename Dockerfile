# syntax=docker/dockerfile:1.7

# ---------- base ----------
FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

# ---------- deps ----------
FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY packages ./packages
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile || pnpm install

# ---------- backend build ----------
FROM deps AS backend-build
RUN pnpm --filter "./packages/backend..." build || true

# ---------- ui build ----------
FROM deps AS ui-build
RUN pnpm --filter "./packages/ui..." build || true

# ---------- scanner build (rust) ----------
FROM rust:1.82-slim-bookworm AS scanner-build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
      pkg-config libssl-dev ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY packages/scanner ./packages/scanner
WORKDIR /app/packages/scanner
RUN cargo build --release || true

# ---------- backend runtime ----------
FROM node:24-bookworm-slim AS backend
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=backend-build /app /app
ENV NODE_ENV=production
EXPOSE 4000
CMD ["node", "packages/backend/dist/index.js"]

# ---------- ui runtime (nginx static) ----------
FROM nginx:1.27-alpine AS ui
COPY --from=ui-build /app/packages/ui/dist /usr/share/nginx/html
EXPOSE 80

# ---------- scanner runtime ----------
FROM debian:bookworm-slim AS scanner
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=scanner-build /app/packages/scanner/target/release/scanner /usr/local/bin/scanner
EXPOSE 7000
CMD ["scanner"]
