# syntax=docker/dockerfile:1.7

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
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile || pnpm install

# ---------- build (web) ----------
FROM deps AS build
RUN pnpm --filter ./packages/web build

# ---------- runtime ----------
FROM node:24-bookworm-slim AS backend
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable \
 && apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=production
EXPOSE 4000
CMD ["pnpm", "--filter", "./packages/backend", "start"]
