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
# CI splits the run in two so that nothing which installs packages ever shares
# a job with the sandbox credentials (or the OIDC token that fetches them):
#   E2E_SDKCK_HOME=<dir> npm run test:e2e:all -- --setup-only  # build + installs
#   E2E_SDKCK_HOME=<dir> npm run test:e2e:all -- --skip-setup  # both legs
# Both take the sdkck home from E2E_SDKCK_HOME and never delete it.
#
# No secrets and no external services are REQUIRED: the core UI tests only
# exercise commands that are fully local and read-only (`synonyms export` on a
# throwaway config dir) or fail client-side, and installing the plugin only
# drops a tarball into a throwaway home. The plugin UI-leg additionally seeds
# auth profiles and executes live read-only commands through the browser for
# every plugin it covers (jira, conni, bb, sentry, trello, api), with the
# sandbox credentials from Infisical: when any aren't already exported, the
# script re-runs itself under `infisical run`, signed in either by a one-time
# `infisical login` or, in a headless sandbox, by a machine identity's
# INFISICAL_UNIVERSAL_AUTH_CLIENT_ID and INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET.
# Plugins whose credentials are still missing skip — unless
# E2E_REQUIRE_CREDENTIALS is set (CI), which makes it an error — and all
# failure output is redacted. An Infisical CLI that is not logged in is only
# a warning, so the core tests still run.
#
# The sdkck host leg needs no extra @hesed plugins: sdkck bundles the other
# plugins as core dependencies, so the installed webui plugin serves a real,
# populated command surface out of the box.
set -euo pipefail

cd "$(dirname "$0")/.."
REPO_ROOT="$PWD"

KEEP=0
SETUP_ONLY=0
SKIP_SETUP=0
PW_ARGS=()

for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    --setup-only) SETUP_ONLY=1 ;;
    --skip-setup) SKIP_SETUP=1 ;;
    *) PW_ARGS+=("$arg") ;;
  esac
done

if [ "$SETUP_ONLY" -ne 0 ] && [ "$SKIP_SETUP" -ne 0 ]; then
  echo "error: --setup-only and --skip-setup are mutually exclusive" >&2
  exit 1
fi

if { [ "$SETUP_ONLY" -ne 0 ] || [ "$SKIP_SETUP" -ne 0 ]; } && [ -z "${E2E_SDKCK_HOME:-}" ]; then
  echo "error: --setup-only and --skip-setup need E2E_SDKCK_HOME set to the sdkck home to share" >&2
  exit 1
fi

if [ "$SKIP_SETUP" -ne 0 ] && [ ! -d "${E2E_SDKCK_HOME}/data" ]; then
  echo "error: --skip-setup found no installed plugins under $E2E_SDKCK_HOME; run --setup-only first" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Credentials — fetched from Infisical for the plugin UI-leg; missing ones
# only skip their tests, they never fail the run.
# ---------------------------------------------------------------------------

# The credentials the plugin UI-leg's tests skip without — what an Infisical
# lookup is for, and what E2E_REQUIRE_CREDENTIALS insists on.
REQUIRED_CREDENTIALS="ATLASSIAN_URL ATLASSIAN_EMAIL ATLASSIAN_API_TOKEN BITBUCKET_API_TOKEN
BITBUCKET_EMAIL E2E_WORKSPACE SENTRY_API_KEY TRELLO_API_KEY TRELLO_SECRET
LINEAR_API_KEY VERCEL_API_KEY CONTEXT7_API_KEY"

# Everything the plugin UI-leg reads, including the optional SENTRY_URL (the
# sentry tests default to https://sentry.io). Building, packing and installing
# run repository, dependency and freshly fetched plugin scripts that never
# need them, so those steps run through without_credentials.
ALL_CREDENTIALS="$REQUIRED_CREDENTIALS SENTRY_URL"

without_credentials() {
  local unset_args=()
  for var in $ALL_CREDENTIALS; do
    unset_args+=(-u "$var")
  done
  env "${unset_args[@]}" "$@"
}

missing_secrets() {
  local var
  for var in $REQUIRED_CREDENTIALS; do
    if [ -z "${!var:-}" ]; then
      echo "$var"
    fi
  done
}

# --setup-only only builds and installs, so it needs no credentials (and in CI
# must not have them).
if [ "$SETUP_ONLY" -eq 0 ] && [ -n "$(missing_secrets)" ] &&
  [ -z "${E2E_VIA_INFISICAL:-}" ] && command -v infisical >/dev/null; then
  infisical_args=(--silent)
  infisical_ready=1
  if [ -n "${INFISICAL_UNIVERSAL_AUTH_CLIENT_ID:-}" ]; then
    # The CLI reads the client id and secret from the environment; passing
    # them as flags would put the secret in the process list.
    if INFISICAL_TOKEN="$(infisical login --method=universal-auth --silent --plain)"; then
      export INFISICAL_TOKEN
    else
      infisical_ready=0
    fi
  fi
  # A machine identity token ignores .infisical.json, so pass its project ID.
  if [ -n "${INFISICAL_TOKEN:-}" ]; then
    infisical_args+=(--projectId "$(node -p "require('./.infisical.json').workspaceId")")
  fi
  # Probe before the exec: a failed `infisical run` (not logged in, no
  # access) would end the whole run, including the core tests that need no
  # credentials. Without Infisical the run carries on, and the plugin UI-leg
  # skips what lacks credentials.
  if [ "$infisical_ready" -eq 1 ] && infisical export "${infisical_args[@]}" >/dev/null 2>&1; then
    # E2E_VIA_INFISICAL stops a second re-exec when Infisical lacks a
    # secret. The absolute path matters: $0 may be relative to the directory
    # we left.
    E2E_VIA_INFISICAL=1 exec infisical run "${infisical_args[@]}" -- "$REPO_ROOT/scripts/e2e.sh" "$@"
  fi
  echo "==> WARNING: could not fetch credentials from Infisical (run \`infisical login\`); continuing without them" >&2
fi

# The sandbox credentials are all the tests need; keep the Infisical ones out
# of their environment.
unset INFISICAL_TOKEN INFISICAL_UNIVERSAL_AUTH_CLIENT_ID INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET

if [ "$SETUP_ONLY" -eq 0 ] && [ -n "$(missing_secrets)" ]; then
  # CI sets E2E_REQUIRE_CREDENTIALS: there a missing credential means a broken
  # Infisical setup, and skipping its tests would leave the run green without
  # the live plugin runs.
  if [ -n "${E2E_REQUIRE_CREDENTIALS:-}" ]; then
    echo "error: missing credentials (E2E_REQUIRE_CREDENTIALS is set): $(missing_secrets | tr '\n' ' ')" >&2
    echo "Check they exist in Infisical's dev environment." >&2
    exit 1
  fi
  echo "==> WARNING: the plugin UI-leg will skip what needs these missing secrets: $(missing_secrets | tr '\n' ' ')"
  echo "    (check Infisical's dev environment, and that the Infisical CLI is installed and logged in)"
fi

# Deliberately NOT named SDKCK_HOME: an inherited SDKCK_HOME could point at
# the developer's real sdkck setup, and the EXIT trap must never rm -rf that.
# This variable only ever holds a path this script itself mktemp'd; a home
# handed in through E2E_SDKCK_HOME (--setup-only/--skip-setup) is never
# deleted.
SDKCK_E2E_HOME=""
OWNS_HOME=0
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

  if [ "$OWNS_HOME" -ne 0 ]; then
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

install_into_home() {
  # A tarball must be passed as a `file:` URL: sdkck resolves any bare path
  # containing a slash as a GitHub org/repo.
  without_credentials \
    SDKCK_CACHE_DIR="$SDKCK_E2E_HOME/cache" \
    SDKCK_CONFIG_DIR="$SDKCK_E2E_HOME/config" \
    SDKCK_DATA_DIR="$SDKCK_E2E_HOME/data" \
    "$REPO_ROOT/node_modules/.bin/sdkck" plugins install "$1" >/dev/null
}

if [ "$SKIP_SETUP" -eq 0 ]; then
  echo "==> Ensuring the Playwright Chromium browser is installed"
  without_credentials npx --no-install playwright install chromium

  echo "==> Building the CLI and the web app"
  without_credentials npm run --silent build
  without_credentials npm run --silent build:web
  # `next build` leaves the static assets out of the standalone output — prepack
  # copies them in before packing. The standalone server serves the same tree,
  # so leg 1 needs the copy too or the browser gets 404ing chunks and never
  # hydrates.
  shx cp -r web/.next/static web/.next/standalone/web/.next/static
fi

if [ "$SETUP_ONLY" -eq 0 ]; then
  echo "==> Leg 1: end-to-end tests through the standalone CLI"
  run_playwright
fi

# A throwaway sdkck home keeps the plugin install, its dependencies (the
# plugin's node_modules, including next, land beside it) and its caches out
# of the developer's real sdkck setup; the test side finds it via
# E2E_SDKCK_HOME.
if [ "$SETUP_ONLY" -ne 0 ] || [ "$SKIP_SETUP" -ne 0 ]; then
  SDKCK_E2E_HOME="$E2E_SDKCK_HOME"
  mkdir -p "$SDKCK_E2E_HOME"
else
  SDKCK_E2E_HOME="$(mktemp -d)"
  OWNS_HOME=1
fi
export E2E_SDKCK_HOME="$SDKCK_E2E_HOME"

if [ "$SKIP_SETUP" -eq 0 ]; then
  echo "==> Downloading the latest sdkck"
  # --no-save resolves "latest" from the registry on every run without touching
  # package.json; the binary comes from node_modules/.bin.
  without_credentials npm install --no-save sdkck

  # Packing runs prepack, regenerating oclif.manifest.json, the web standalone
  # build and the README — the same artifacts the publish workflow ships — so
  # the host leg exercises the real install artifact.
  WEBUI_README_BAK="$SDKCK_E2E_HOME/webui-README.md.bak"
  cp "$REPO_ROOT/README.md" "$WEBUI_README_BAK"
  echo "==> Packing the current build"
  TGZ="$(without_credentials npm pack --pack-destination "$SDKCK_E2E_HOME" | tail -n 1)"

  echo "==> Installing @hesed/webui (this build) into the throwaway home"
  # Installing this build before any sdkck command runs guarantees the host
  # dispatches the build under test, not a release it might otherwise
  # auto-install.
  install_into_home "file:$SDKCK_E2E_HOME/$TGZ"

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
    install_into_home "@hesed/$plugin@latest"
  done

  # trello is the one credential-backed plugin the host does not JIT-install,
  # so install it from the registry for the plugin UI-leg; without its
  # credentials, the suite skips trello. Unconditional, because --setup-only
  # never has the credentials to decide on.
  echo "==> Installing @hesed/trello@latest"
  install_into_home "@hesed/trello@latest"
fi

if [ "$SETUP_ONLY" -ne 0 ]; then
  echo "==> sdkck and plugins installed into $SDKCK_E2E_HOME"
  exit 0
fi

echo "==> Leg 2: end-to-end tests through the sdkck host CLI"
E2E_HOST_CLI=sdkck run_playwright
