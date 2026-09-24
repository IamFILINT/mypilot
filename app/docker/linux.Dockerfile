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
# (scripts/build-python-runtime.mjs). The apt python3 above is not used for that
# payload; it satisfies build tooling only.
COPY --from=ghcr.io/astral-sh/uv:0.12.13 /uv /usr/local/bin/uv
RUN uv --version

ARG APPIMAGETOOL_URL=https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage
RUN curl -fsSL "$APPIMAGETOOL_URL" -o /usr/local/bin/appimagetool \
  && chmod +x /usr/local/bin/appimagetool

WORKDIR /workspace

# Keep dependency install cacheable when source files change.
COPY app/package.json app/yarn.lock ./app/
COPY app/scripts/chmod-node-pty-helpers.mjs ./app/scripts/
WORKDIR /workspace/app
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
    MYPILOT_STAGE_DIR=/workspace/app/.forge-stage

WORKDIR /workspace/app
RUN yarn run make -- --platform=linux --arch=x64
RUN test -f "/workspace/app/out/MyPilot-linux-x64/resources/app-update.yml"
RUN node ../scripts/build-linux-appimage.mjs \
    --package-dir "/workspace/app/out/MyPilot-linux-x64" \
    --output-dir /workspace/app/out/make/appimage/x64 \
  && node scripts/generate-linux-update-feed.mjs \
    --version "$(node -p 'require("./package.json").version')" \
    --release-date "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" \
    --output /workspace/app/out/make/latest-linux.yml \
    /workspace/app/out/make/appimage/x64/*.AppImage
RUN node ../scripts/verify-linux-artifacts.mjs
