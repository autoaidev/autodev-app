#!/usr/bin/env bash
#
# setup_dev_env.sh — Provision a clean machine (dev workstation or CI runner) to
# build and TEST the AutoDev Electron desktop app, including HEADLESS runs.
#
# What this installs and why:
#   - Base build toolchain (build-essential, python3, make, g++, pkg-config) so
#     the native module `node-pty` can be compiled and rebuilt against Electron.
#   - The Chromium/Electron runtime shared libraries + Xvfb + fonts required for
#     an Electron app to launch HEADLESSLY under a virtual X server. This list is
#     reused from the headless-coding-vm repo's Dockerfiles / docker/install.sh
#     (see headless-coding-vm/v5_copilot/Dockerfile and v9_copilot/docker/install.sh),
#     which run the same class of Chromium-based CLIs/apps in headless VMs.
#   - Node.js pinned via NodeSource (setup_${NODE_MAJOR}.x), matching
#     headless-coding-vm's `deb.nodesource.com/setup_22.x`. Node 22 is required
#     (node:sqlite / native TS type-stripping for the *.test.mts test runner).
#
# Then, inside the app repo:
#   - `npm ci` (fallback `npm install`) to install JS deps.
#   - Rebuild the `node-pty` native addon against Electron's ABI via
#     @electron/rebuild (a devDependency of this repo). This is NOT automatic on
#     install (there is no postinstall hook), so we do it explicitly. The
#     electron-builder targets (`npm run dist`) also run install-app-deps, but for
#     dev/test we rebuild directly.
#   - `npm run build` (electron-vite build → ./out) — compiles without producing a
#     full AppImage. Set BUILD_DIST=1 to instead produce a distributable
#     (`npm run dist`, electron-builder; needs network for bundle:cli).
#
# Sources: headless-coding-vm (v5_copilot/Dockerfile, v9_copilot/docker/install.sh)
#          autodev-app/package.json (engines, scripts, deps: node-pty, electron,
#          @electron/rebuild, electron-vite, electron-builder).
#
# Usage:
#   bash scripts/setup_dev_env.sh [--with-external]
#
#   --with-external   after setup, clone + set up the accompanying AutoDev repos
#                     (pixel-office, autodev-cli) into external/ (git-ignored).
#
# Env toggles (all optional):
#   NODE_MAJOR=22     Node major version to install via NodeSource (default 22).
#   SKIP_SYSTEM=1     Skip apt/system + Node install (JS deps + build only).
#   SKIP_BUILD=1      Skip `npm run build` (deps + native rebuild only).
#   BUILD_DIST=1      Produce a distributable via `npm run dist` instead of build.
#
set -euo pipefail

# ----------------------------------------------------------------------------
# Config
# ----------------------------------------------------------------------------
NODE_MAJOR="${NODE_MAJOR:-22}"
SKIP_SYSTEM="${SKIP_SYSTEM:-0}"
SKIP_BUILD="${SKIP_BUILD:-0}"
BUILD_DIST="${BUILD_DIST:-0}"

# --- arg parsing (env toggles above still all work) ------------------------
WITH_EXTERNAL=0
for arg in "$@"; do
  case "$arg" in
    --with-external) WITH_EXTERNAL=1 ;;
    -h|--help)
      echo "Usage: $0 [--with-external]"
      echo "  --with-external   after setup, clone + set up the accompanying AutoDev repos into external/"
      exit 0 ;;
    *) ;;  # ignore unknown args gracefully
  esac
done

# Resolve repo root as the parent of this script's directory (repo/scripts/..).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------
section() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
info()    { printf '    %s\n' "$*"; }
warn()    { printf '\033[1;33m[warn]\033[0m %s\n' "$*" >&2; }

# sudo only when not already root (CI containers usually run as root).
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
  else
    warn "Not root and 'sudo' not found; system package install may fail."
  fi
fi

apt_install() {
  DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y --no-install-recommends "$@"
}

# ----------------------------------------------------------------------------
# Optional: clone + set up the accompanying AutoDev product repos into external/
# ----------------------------------------------------------------------------
# The OTHER product repos that pair with this one. Edit freely (name -> git url).
declare -A EXTERNAL_REPOS=(
  [pixel-office]="https://github.com/autoaidev/pixel-office.git"
  [autodev-cli]="https://github.com/autoaidev/autodev-cli.git"
)

setup_external_repos() {
  local root
  root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

  echo ""
  echo "=================================================="
  echo " Cloning accompanying repos into external/"
  echo "=================================================="

  mkdir -p "${root}/external"

  # Ensure external/ is git-ignored (idempotent — add the line at most once).
  if [ -f "${root}/.gitignore" ] && grep -qxF 'external/' "${root}/.gitignore"; then
    echo "  .gitignore already ignores external/"
  else
    echo 'external/' >> "${root}/.gitignore"
    echo "  Added 'external/' to .gitignore"
  fi

  local name url dir found
  for name in "${!EXTERNAL_REPOS[@]}"; do
    url="${EXTERNAL_REPOS[$name]}"
    dir="${root}/external/${name}"
    echo ""
    echo "--- ${name} (${url}) ---"
    if [ -d "${dir}/.git" ]; then
      echo "  Exists — pulling latest (ff-only)"
      git -C "${dir}" pull --ff-only || true
    else
      echo "  Cloning..."
      git clone "${url}" "${dir}" || { echo "  ! clone failed for ${name} — skipping"; continue; }
    fi

    # Run the repo's own setup script if present. Pass SKIP_SYSTEM=1 (avoid redundant
    # apt installs) and NEVER pass --with-external so this does not recurse.
    found=""
    if [ -f "${dir}/scripts/setup_dev_env.sh" ]; then
      found="setup_dev_env.sh"
    elif [ -f "${dir}/scripts/install_dev_env.sh" ]; then
      found="install_dev_env.sh"
    fi
    if [ -n "${found}" ]; then
      echo "  Running scripts/${found} (SKIP_SYSTEM=1)"
      ( cd "${dir}" && SKIP_SYSTEM=1 bash "scripts/${found}" ) || echo "  ! setup failed for ${name} (continuing)"
    else
      echo "  No setup script in ${name}/scripts — skipping setup"
    fi
  done

  echo ""
  echo "  External repos ready under ${root}/external/"
}

# ----------------------------------------------------------------------------
# 1. System packages: build tools + Electron/headless runtime + Xvfb + fonts
# ----------------------------------------------------------------------------
if [ "$SKIP_SYSTEM" = "1" ]; then
  section "System packages: SKIPPED (SKIP_SYSTEM=1)"
else
  section "System packages: build tools, Electron headless runtime, Xvfb, fonts"
  $SUDO apt-get update

  # Base toolchain to compile the node-pty native addon + fetch/unpack utils.
  apt_install \
    build-essential \
    python3 \
    pkg-config \
    make \
    g++ \
    git \
    curl \
    wget \
    unzip \
    ca-certificates \
    gnupg \
    lsb-release

  # Chromium/Electron runtime shared libraries. Electron embeds Chromium, so the
  # binary dynamically links these; without them the app aborts before opening a
  # window (even headless). Reused from headless-coding-vm Dockerfiles.
  apt_install \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libatspi2.0-0 \
    libcups2 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libpango-1.0-0 \
    libcairo2 \
    libx11-6 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxrandr2 \
    libxkbcommon0 \
    libxshmfence1 \
    libxss1 \
    libxtst6 \
    libasound2 \
    libsecret-1-0

  # Virtual X server + X utilities to launch the GUI app HEADLESSLY, plus fonts
  # so rendered text (and the test/smoke UI) has glyphs to draw.
  apt_install \
    xvfb \
    xauth \
    x11-utils \
    fonts-liberation \
    fonts-dejavu-core \
    fonts-noto-color-emoji

  # --------------------------------------------------------------------------
  # Node.js via NodeSource (pinned major), matching headless-coding-vm.
  # --------------------------------------------------------------------------
  section "Node.js ${NODE_MAJOR}.x via NodeSource"
  current_node_major=""
  if command -v node >/dev/null 2>&1; then
    current_node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo "")"
  fi
  if [ "$current_node_major" = "$NODE_MAJOR" ]; then
    info "Node $(node -v) already installed (major ${NODE_MAJOR}); skipping."
  else
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | $SUDO -E bash -
    apt_install nodejs
  fi
  info "node: $(node -v)   npm: $(npm -v)"
fi

# ----------------------------------------------------------------------------
# 2. JS dependencies (npm ci, fallback npm install)
# ----------------------------------------------------------------------------
section "Installing JS dependencies in ${REPO_DIR}"
cd "$REPO_DIR"

if [ -f package-lock.json ]; then
  npm ci || {
    warn "npm ci failed (lockfile drift?); falling back to npm install."
    npm install
  }
else
  warn "No package-lock.json found; using npm install."
  npm install
fi

# ----------------------------------------------------------------------------
# 3. Rebuild native module (node-pty) against Electron's ABI
# ----------------------------------------------------------------------------
# node-pty is a native addon; npm installs it built for the system Node ABI, but
# the app loads it inside Electron (a different ABI). @electron/rebuild (a repo
# devDependency) recompiles it for the bundled Electron. There is no postinstall
# hook, so this must be run explicitly.
section "Rebuilding native module (node-pty) for Electron"
if npx --no-install electron-rebuild --version >/dev/null 2>&1; then
  npx --no-install electron-rebuild -f -w node-pty
elif npx --no-install @electron/rebuild --version >/dev/null 2>&1; then
  npx --no-install @electron/rebuild -f -w node-pty
else
  warn "@electron/rebuild not found in node_modules; trying electron-builder install-app-deps."
  npx --no-install electron-builder install-app-deps || \
    warn "Could not rebuild node-pty against Electron. The app may fail to launch until this is fixed."
fi

# ----------------------------------------------------------------------------
# 4. Build
# ----------------------------------------------------------------------------
if [ "$SKIP_BUILD" = "1" ]; then
  section "Build: SKIPPED (SKIP_BUILD=1)"
elif [ "$BUILD_DIST" = "1" ]; then
  section "Building distributable (npm run dist — electron-builder)"
  info "Note: bundle:cli may require network access to assemble vendor/autodev-cli."
  npm run dist
else
  section "Building app bundle (npm run build — electron-vite → ./out)"
  npm run build
fi

# ----------------------------------------------------------------------------
# 5. Summary + how to run HEADLESSLY
# ----------------------------------------------------------------------------
section "Environment ready"
cat <<EOF
Repo:  ${REPO_DIR}
Node:  $(node -v 2>/dev/null || echo 'n/a')   npm: $(npm -v 2>/dev/null || echo 'n/a')

Run the unit tests (pure Node test runner — no display needed):

    npm test        # node --test "test/*.test.mts"

Type-check:

    npm run typecheck

Launch / smoke-run the Electron app HEADLESSLY (needs a virtual X server):

    xvfb-run -a npm start                      # electron-vite preview under Xvfb
    # or run the built main directly under Xvfb:
    xvfb-run -a npx electron ./out/main/index.js

CI caveat: Electron's Chromium sandbox needs kernel privileges that most CI
containers lack. If you see a "SUID sandbox" / namespace error, disable it:

    export ELECTRON_DISABLE_SANDBOX=1
    xvfb-run -a npx electron --no-sandbox ./out/main/index.js

To produce a distributable AppImage/deb instead of a bundle, re-run with:

    BUILD_DIST=1 bash scripts/setup_dev_env.sh
EOF

if [ "$WITH_EXTERNAL" = "1" ]; then
  setup_external_repos
fi
