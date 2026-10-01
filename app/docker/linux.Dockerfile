FROM node:22-bookworm AS linux-package

ENV DEBIAN_FRONTEND=noninteractive
ENV ELECTRON_CACHE=/root/.cache/electron
ENV npm_config_update_notifier=false

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    dpkg \
    dpkg-dev \
    fakeroot \
    file \
    g++ \
    git \
    libsecret-1-dev \
    make \
    pkg-config \
    python3 \
    rpm \
    xz-utils \
  && rm -rf /var/lib/apt/lists/*

# uv provisions the relocatable CPython that ships as resources/python-runtime
# (app/app/scripts/build-python-runtime.mjs). The apt python3 above is not used
# for that payload; it satisfies build tooling only.
COPY --from=ghcr.io/astral-sh/uv:0.12.13 /uv /usr/local/bin/uv
RUN uv --version

ARG APPIMAGETOOL_URL=https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage
RUN curl -fsSL "$APPIMAGETOOL_URL" -o /usr/local/bin/appimagetool \
  && chmod +x /usr/local/bin/appimagetool

WORKDIR /workspace

# The Electron app lives at app/app in the repository, not app/. Copy only the
# manifest and lockfile first so the dependency layer stays cacheable, and copy
# the postinstall helper alongside them because yarn runs it during install.
COPY app/app/package.json app/app/yarn.lock ./app/app/
COPY app/app/scripts/chmod-node-pty-helpers.mjs ./app/app/scripts/
WORKDIR /workspace/app/app
RUN sed -i 's#git+ssh://git@github.com/#git+https://github.com/#g; s#ssh://git@github.com/#https://github.com/#g' yarn.lock package.json
RUN yarn install --frozen-lockfile

WORKDIR /workspace
COPY . .

# The build context is the product monorepo root, so the packaged sources land
# at /workspace/sidecar and /workspace/browser-use. runtime staging resolves
# them from the app dir by default, which assumes the two-levels-up layout of a
# local checkout; inside the container that heuristic misses, so pin them.
ENV MYPILOT_SIDECAR_SRC=/workspace/sidecar \
    MYPILOT_BROWSER_USE_SRC=/workspace/browser-use \
    MYPILOT_STAGE_DIR=/workspace/app/app/.forge-stage

# Forge must run from the directory that holds the Electron source tree, so the
# container layout mirrors the repository instead of collapsing app/app into
# app. forge.config.ts, the vite configs and the src tree all sit in app/app.
WORKDIR /workspace/app/app
RUN yarn run make -- --platform=linux --arch=x64
RUN test -f "/workspace/app/app/out/MyPilot-linux-x64/resources/app-update.yml"
# Build tooling (AppImage wrapper, artifact verifier) lives in the workspace
# scripts dir; the update-feed generator ships with the app itself.
RUN node /workspace/app/scripts/build-linux-appimage.mjs \
    --package-dir "/workspace/app/app/out/MyPilot-linux-x64" \
    --output-dir /workspace/app/app/out/make/appimage/x64 \
  && node /workspace/app/app/scripts/generate-linux-update-feed.mjs \
    --version "$(node -p 'require("./package.json").version')" \
    --release-date "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" \
    --output /workspace/app/app/out/make/latest-linux.yml \
    /workspace/app/app/out/make/appimage/x64/*.AppImage
RUN node /workspace/app/scripts/verify-linux-artifacts.mjs
