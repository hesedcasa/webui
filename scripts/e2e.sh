#!/usr/bin/env bash
# Runs the end-to-end suite twice: once through the built standalone CLI
# (`bin/run.js`), then again through the latest sdkck host CLI with this build
# packed (`npm pack`, exercising `prepack`) and installed as its
# `@hesed/webui` plugin. On both legs the @playwright/test runner drives a
# headless Chromium against the served web UI, and the JSON API is asserted
# over real HTTP.
#
#   npm run test:e2e:all                        # everything
#   npm run test:e2e:all -- --grep "runs a command" # extra args go to playwright test
#   npm run test:e2e:all -- --keep              # leave the throwaway home behind
#
# No secrets and no external services are REQUIRED: the core UI tests only
# exercise commands that are fully local and read-only (`synonyms export` on a
# throwaway config dir) or fail client-side, and installing the plugin only
# drops a tarball into a throwaway home. When a gitignored .env carries
# sandbox credentials, the plugin UI-leg additionally seeds auth profiles and
# executes live read-only commands through the browser for every plugin it
# covers (jira, conni, bb, sentry, trello, api) — plugins without credentials
# skip, and all failure output is redacted.
#
# The sdkck host leg needs no extra @hesed plugins: sdkck bundles the other
# plugins as core dependencies, so the installed webui plugin serves a real,
# populated command surface out of the box.
set -euo pipefail

cd "$(dirname "$0")/.."
REPO_ROOT="$PWD"

# Load the developer's gitignored .env (same convention as the sdkck host
# suite): it carries the sandbox credentials the plugin UI-leg seeds and the
# test side redacts, and decides whether @hesed/trello gets installed. Never
# overrides variables already set in the environment; values are not sourced
# as shell code, only parsed as KEY=VALUE.
if [ -f "$REPO_ROOT/.env" ]; then
  while IFS='=' read -r key value; do
    case "$key" in ''|\#*) continue ;; esac
    case "$key" in *[!A-Z0-9_]*) continue ;; esac
    value="${value%\"}"
    value="${value#\"}"
    if [ -z "${!key:-}" ]; then
      export "$key=$value"
    fi
  done < "$REPO_ROOT/.env"
fi

KEEP=0
PW_ARGS=()

for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    *) PW_ARGS+=("$arg") ;;
  esac
done

# Deliberately NOT named SDKCK_HOME: an inherited SDKCK_HOME could point at
# the developer's real sdkck setup, and the EXIT trap must never rm -rf that.
# This variable only ever holds a path this script itself mktemp'd.
SDKCK_E2E_HOME=""
WEBUI_README_BAK=""

cleanup() {
  local status=$?

  # npm pack's prepack (`oclif readme`) rewrites the tracked README.md with
  # the current machine's usage string, so it is restored here — an e2e run
  # must never dirty a worktree or clobber uncommitted README edits. The
  # backup lives in the throwaway home, so a run killed before its restore
  # (SIGKILL skips this trap) leaves its recovery copy behind undisturbed:
  # the next run writes a different name and can never overwrite it.
  if [ -n "$WEBUI_README_BAK" ] && [ -f "$WEBUI_README_BAK" ]; then
    mv "$WEBUI_README_BAK" "$REPO_ROOT/README.md"
  fi

  if [ "$KEEP" -ne 0 ]; then
    echo "==> Leaving the throwaway home in place (--keep): $SDKCK_E2E_HOME"
    exit "$status"
  fi

  if [ -n "$SDKCK_E2E_HOME" ]; then
    rm -rf "$SDKCK_E2E_HOME"
  fi

  exit "$status"
}
trap cleanup EXIT

run_playwright() {
  # Delegates to the `test:e2e` script (playwright test) so both legs share
  # one config. The +expansion guard keeps `set -u` happy with an empty array
  # on bash 3.2.
  npm run --silent test:e2e -- ${PW_ARGS[@]+"${PW_ARGS[@]}"}
}

echo "==> Ensuring the Playwright Chromium browser is installed"
npx --no-install playwright install chromium

echo "==> Building the CLI and the web app"
npm run --silent build
npm run --silent build:web
# `next build` leaves the static assets out of the standalone output — prepack
# copies them in before packing. The standalone server serves the same tree,
# so leg 1 needs the copy too or the browser gets 404ing chunks and never
# hydrates.
shx cp -r web/.next/static web/.next/standalone/web/.next/static

echo "==> Leg 1: end-to-end tests through the standalone CLI"
run_playwright

echo "==> Downloading the latest sdkck"
# --no-save resolves "latest" from the registry on every run without touching
# package.json; the binary comes from node_modules/.bin.
npm install --no-save sdkck

# A throwaway sdkck home keeps the plugin install, its dependencies (the
# plugin's node_modules, including next, land beside it) and its caches out
# of the developer's real sdkck setup; the test side finds it via
# E2E_SDKCK_HOME.
SDKCK_E2E_HOME="$(mktemp -d)"
export E2E_SDKCK_HOME="$SDKCK_E2E_HOME"

# Packing runs prepack, regenerating oclif.manifest.json, the web standalone
# build and the README — the same artifacts the publish workflow ships — so
# the host leg exercises the real install artifact.
WEBUI_README_BAK="$SDKCK_E2E_HOME/webui-README.md.bak"
cp "$REPO_ROOT/README.md" "$WEBUI_README_BAK"
echo "==> Packing the current build"
TGZ="$(npm pack --pack-destination "$SDKCK_E2E_HOME" | tail -n 1)"

echo "==> Installing @hesed/webui (this build) into the throwaway home"
# A tarball must be passed as a `file:` URL: sdkck resolves any bare path
# containing a slash as a GitHub org/repo. Installing this build before any
# sdkck command runs guarantees the host dispatches the build under test, not
# a release it might otherwise auto-install.
SDKCK_CACHE_DIR="$SDKCK_E2E_HOME/cache" \
SDKCK_CONFIG_DIR="$SDKCK_E2E_HOME/config" \
SDKCK_DATA_DIR="$SDKCK_E2E_HOME/data" \
  "$REPO_ROOT/node_modules/.bin/sdkck" plugins install "file:$SDKCK_E2E_HOME/$TGZ" >/dev/null

# The host installs its JIT-pinned plugins lazily, on the first dispatch of
# one of their commands. The webui server, however, builds its command cache
# once at startup — a plugin installed only afterwards leaves the server
# holding a ghost manifest entry (sdkck's shipped oclif.manifest.json lists
# every JIT command with paths that do not exist in the sdkck package) whose
# in-process execution always fails. The plugin UI-leg seeds auth and runs
# commands for jira, conni, bb and sentry, so those are installed eagerly;
# plugins the leg never executes can stay on the lazy path.
for plugin in jira conni bb sentry; do
  echo "==> Installing JIT plugin @hesed/$plugin@latest"
  SDKCK_CACHE_DIR="$SDKCK_E2E_HOME/cache" \
  SDKCK_CONFIG_DIR="$SDKCK_E2E_HOME/config" \
  SDKCK_DATA_DIR="$SDKCK_E2E_HOME/data" \
    "$REPO_ROOT/node_modules/.bin/sdkck" plugins install "@hesed/$plugin@latest" >/dev/null
done

# trello is the one credential-backed plugin the host does not JIT-install.
# When its credentials exist in .env, install it from the registry so the
# plugin UI-leg can exercise it; without them, the suite skips trello.
if [ -n "${TRELLO_API_KEY:-}" ] && [ -n "${TRELLO_SECRET:-}" ]; then
  echo "==> Installing @hesed/trello@latest (credentials found in .env)"
  SDKCK_CACHE_DIR="$SDKCK_E2E_HOME/cache" \
  SDKCK_CONFIG_DIR="$SDKCK_E2E_HOME/config" \
  SDKCK_DATA_DIR="$SDKCK_E2E_HOME/data" \
    "$REPO_ROOT/node_modules/.bin/sdkck" plugins install "@hesed/trello@latest" >/dev/null
fi

echo "==> Leg 2: end-to-end tests through the sdkck host CLI"
E2E_HOST_CLI=sdkck run_playwright
