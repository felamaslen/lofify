#!/usr/bin/env bash
set -euo pipefail

IMAGE="felamaslen/lofify"
TAG="latest"
PLATFORM="linux/amd64"
HOST=""
DIRECTORY="/opt/lofify"
NFS_HOST=""
NFS_PATH=""
SKIP_BUILD=0

usage() {
  cat >&2 <<EOF
Usage: $0 --host <ssh-host> --nfs-host <addr> --nfs-path <path> [--directory <remote-path>] [--tag <tag>] [--platform <platform>] [--skip-build]

Builds and pushes the ${IMAGE} Docker image, then deploys it to a remote
host via docker compose.

Options:
  --host <ssh-host>      SSH host to deploy to (required)
  --nfs-host <addr>      NFS server address for the playback cache (required)
  --nfs-path <path>      Exported directory on the NFS server (required)
  --directory <path>     Remote directory for compose file (default: ${DIRECTORY})
  --tag <tag>            Image tag (default: ${TAG})
  --platform <platform>  Build platform (default: ${PLATFORM})
  --skip-build           Skip the build/push step (deploy only)

Requires a local .env.production file; it is copied to {directory}/.env
on the remote host.
EOF
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host)
      HOST="${2:-}"
      shift 2
      ;;
    --directory)
      DIRECTORY="${2:-}"
      shift 2
      ;;
    --nfs-host)
      NFS_HOST="${2:-}"
      shift 2
      ;;
    --nfs-path)
      NFS_PATH="${2:-}"
      shift 2
      ;;
    --tag)
      TAG="${2:-}"
      shift 2
      ;;
    --platform)
      PLATFORM="${2:-}"
      shift 2
      ;;
    --skip-build)
      SKIP_BUILD=1
      shift
      ;;
    -h|--help)
      usage
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      ;;
  esac
done

if [[ -z "$HOST" || -z "$NFS_HOST" || -z "$NFS_PATH" ]]; then
  usage
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ ! -f .env.production ]]; then
  echo "Missing .env.production at repo root" >&2
  exit 1
fi

SHA="$(git rev-parse --short HEAD 2>/dev/null || echo "dev")"

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  echo "==> Building & pushing ${IMAGE}:${TAG} (also ${SHA}) for ${PLATFORM}"
  docker buildx build \
    --platform "$PLATFORM" \
    --target backend \
    -t "${IMAGE}:${TAG}" \
    -t "${IMAGE}:${SHA}" \
    --push \
    .
fi

echo "==> Copying compose file and .env to ${HOST}:${DIRECTORY}"
ssh "$HOST" "mkdir -p '$DIRECTORY'"

COMPOSE_TMP="$(mktemp)"
trap 'rm -f "$COMPOSE_TMP"' EXIT
sed -e "s|__NFS_HOST__|${NFS_HOST}|g" \
    -e "s|__NFS_PATH__|${NFS_PATH}|g" \
    docker-compose.prod.yml >"$COMPOSE_TMP"

scp "$COMPOSE_TMP" "${HOST}:${DIRECTORY}/docker-compose.yml"
scp .env.production "${HOST}:${DIRECTORY}/.env"

echo "==> Pulling images on ${HOST}"
ssh "$HOST" "cd '$DIRECTORY' && TAG='${TAG}' docker compose pull"

echo "==> Running database migrations on ${HOST}"
ssh "$HOST" "cd '$DIRECTORY' && TAG='${TAG}' docker compose run --rm backend pnpm --filter ./packages/backend db:migrate"

echo "==> Starting service on ${HOST}"
ssh "$HOST" "cd '$DIRECTORY' && TAG='${TAG}' docker compose up -d"

echo "==> Done"
