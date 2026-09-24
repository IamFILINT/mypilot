#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The Dockerfile copies `app/...` paths, so the build context is the product
# monorepo root — not the app dir. That also makes /workspace/sidecar and
# /workspace/browser-use available to the packaging step.
BUILD_CONTEXT="${BUILD_CONTEXT:-$(cd "$APP_DIR/.." && pwd)}"
IMAGE_TAG="${IMAGE_TAG:-desktop-app-linux-package:local}"
DOCKER_PLATFORM="${DOCKER_PLATFORM:-linux/amd64}"

if ! docker info >/dev/null 2>&1; then
  echo "Docker is installed, but the daemon is not running."
  echo "Start Docker Desktop, then rerun: task linux:make:docker"
  exit 1
fi

# Preflight: the MyPilot Agent payload is staged from these trees at package
# time. Fail here with a clear message instead of midway through the build.
if [ ! -f "$BUILD_CONTEXT/sidecar/pyproject.toml" ]; then
  echo "Missing $BUILD_CONTEXT/sidecar/pyproject.toml"
  echo "The build context must be the product monorepo root (the parent of the app dir)."
  echo "Set BUILD_CONTEXT=<path> to override."
  exit 1
fi
if [ ! -f "$BUILD_CONTEXT/browser-use/pyproject.toml" ]; then
  echo "Missing $BUILD_CONTEXT/browser-use/pyproject.toml"
  echo "The browser-use fork must be present in the build context."
  echo "Clone it to <monorepo>/browser-use (gitignored) or set BUILD_CONTEXT to a root that contains it."
  exit 1
fi

docker build \
  --platform "$DOCKER_PLATFORM" \
  -f "$APP_DIR/docker/linux.Dockerfile" \
  -t "$IMAGE_TAG" \
  "$BUILD_CONTEXT"

container_id="$(docker create "$IMAGE_TAG")"
tmp_dir="$(mktemp -d)"
cleanup() {
  docker rm "$container_id" >/dev/null 2>&1 || true
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

mkdir -p "$APP_DIR/out/make"
rm -rf \
  "$APP_DIR/out/make/deb" \
  "$APP_DIR/out/make/rpm" \
  "$APP_DIR/out/make/appimage" \
  "$APP_DIR/out/make/latest-linux.yml"
docker cp "$container_id:/workspace/app/out/make" "$tmp_dir/make"
cp -R "$tmp_dir/make/." "$APP_DIR/out/make/"

node "$APP_DIR/scripts/verify-linux-artifacts.mjs"
