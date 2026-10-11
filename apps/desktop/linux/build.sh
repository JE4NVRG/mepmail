#!/usr/bin/env bash
# Builds the Linux bundles inside the container from linux/Dockerfile.
#   /src  the apps/desktop sources (read-only; node_modules and target stay on the host)
#   /out  where the AppImage, .deb, .rpm and the AppImage .sig land
# Cargo's registry and target live in a Docker volume (/cache) between runs.
# TAURI_SIGNING_PRIVATE_KEY (optional) signs the AppImage for the updater.
set -euo pipefail

rsync -a --delete --exclude node_modules --exclude src-tauri/target /src/ /work/
cd /work
npm ci --no-audit --no-fund

export CARGO_TARGET_DIR=/cache/target
mkdir -p /cache/registry && ln -sfn /cache/registry "$CARGO_HOME/registry"

# Linux has no older install to keep in place, so the menu entry, package and
# command carry the product's name (Windows keeps "MepMail Correio" inside).
updater=true
if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  # Without the key a release build cannot write updater signatures.
  updater=false
fi
config=$(cat <<JSON
{
  "productName": "MepMail",
  "mainBinaryName": "mepmail",
  "bundle": {
    "createUpdaterArtifacts": $updater,
    "shortDescription": "Email for people and their agents",
    "longDescription": "Correio, the MepMail inbox for people and their agents, as a desktop app."
  }
}
JSON
)
# The cache keeps target/ between runs: older bundles must not ride along.
bundle="$CARGO_TARGET_DIR/release/bundle"
rm -rf "$bundle"
npx tauri build --bundles appimage,deb,rpm --config "$config"

mkdir -p /out
find "$bundle/appimage" "$bundle/deb" "$bundle/rpm" -maxdepth 1 -type f \
  \( -name '*.AppImage' -o -name '*.deb' -o -name '*.rpm' -o -name '*.sig' \) -exec cp {} /out/ \;
ls -la /out
