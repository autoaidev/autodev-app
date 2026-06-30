#!/usr/bin/env bash
# Build the Windows NSIS installer on Linux/macOS via the official electron-builder
# wine image (the host cannot run the 32-bit rcedit step without wine32).
# Assumes `npm run build` has already produced out/. Output: dist/AutoDev Setup <ver>.exe
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v docker >/dev/null; then
  echo "docker is required to cross-build the Windows target on this host." >&2
  exit 1
fi

docker run --rm \
  -v "$PWD":/project \
  -v "$HOME/.cache/electron":/root/.cache/electron \
  -v "$HOME/.cache/electron-builder":/root/.cache/electron-builder \
  electronuserland/builder:wine \
  /bin/bash -c "cd /project && npx electron-builder --win"

# Container runs as root; hand the artifacts back to the invoking user.
if command -v sudo >/dev/null; then sudo chown -R "$(id -u):$(id -g)" dist 2>/dev/null || true; fi
echo "✓ Windows installer in dist/"
ls -lh dist/*.exe 2>/dev/null || true
