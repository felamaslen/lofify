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

# ---------- web build ----------
FROM deps AS web-build
RUN pnpm --filter "./packages/web..." build || true

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

# ---------- web runtime (nginx static) ----------
FROM nginx:1.27-alpine AS web
COPY --from=web-build /app/packages/web/dist /usr/share/nginx/html
EXPOSE 80
