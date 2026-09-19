This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Common Commands

- **Build:** `npm run build` (cleans `dist/` and compiles TypeScript)
- **Build web app:** `npm run build:web` (Next.js standalone build under `web/.next/standalone`)
- **Test:** `npm run test` (runs mocha, then lint via `posttest`; excludes `test/e2e/**`)
- **Run single test:** `npx mocha --forbid-only "test/path/to/file.test.ts"`
- **E2E:** `npm run test:e2e` (web UI suite driven by Playwright — see "Web UI end-to-end suite" below)
- **Lint:** `npm run lint` (ESLint with oclif + prettier configs)
- **Format:** `npm run format` (ESLint --fix + Prettier write)
- **Dev run:** `./bin/dev.js webui --port 4040` (runs the CLI from source via ts-node; the `webui` command serves the standalone web build, so `npm run build:web` must have run at least once)

## Testing

Tests run with mocha + chai via ts-node/esm (`.mocharc.json`), files named `*.test.ts` under `test/`. `npm test` excludes `test/e2e/**`; the e2e suite runs only through `npm run test:e2e` (or `npm run e2e:mocha` against an existing `--keep` home).

### Web UI end-to-end suite

`test/e2e/` + `scripts/e2e.sh` (`npm run test:e2e`) verify the web UI served by the built CLI. The same suite runs twice — two legs:

- **Leg 1 (standalone):** `bin/run.js webui` serves the Next.js standalone build plus the JSON API on a pre-claimed free port. The standalone surface has no commands besides `webui` itself, which `describeCommands` hides, so the API surface is empty and the UI renders its empty state.
- **Leg 2 (sdkck host):** the script packs this build (`npm pack`, exercising `prepack` — the web standalone build, `oclif.manifest.json`, README) and installs it as the host's `@hesed/webui` plugin into a throwaway sdkck home (`E2E_SDKCK_HOME`), then the same argv (`webui --port … --host …`) goes to the `sdkck` binary with oclif's bin-scoped `SDKCK_*` dirs redirected into that home. The host's bundled plugins provide a real command surface (colon-form ids like `synonyms:export`), so the browser tests exercise listing, query/topic filtering, the detail pane, and the run flow. `synonyms:export` against the throwaway config dir is the deterministic read-only round-trip from browser form to `/api/run` to the installed command; `synonyms:import` without its required `<file>` argument covers the failure path.

Both legs drive headless Chromium through the `playwright` library (mocha stays the single runner — no `@playwright/test`) and assert the JSON API over real HTTP. The server child is spawned detached; readiness waits for the CLI's `Web UI ready at <url>` line rather than polling, and the process group is killed on teardown so nothing outlives the run.

- No secrets and no external state: installing the plugin only drops a tarball into the throwaway home, and every fixture lives in a throwaway config dir removed in `after` hooks — nothing to sweep (unlike the sdkck host suite's sandbox legs).
- Every executed browser test captures a full-page screenshot of its resulting page — pass or fail — to `test/e2e/screenshots/<leg>/<nn>-<PASS|FAIL>-<title>.png` (gitignored), so a run leaves a browsable record and failures are scannable with plain `ls`.
- Prepack's `oclif readme` rewrites the tracked README.md, so the script backs it up before packing and restores it from the EXIT trap; an e2e run never dirties the worktree.
- Leg 1 replicates one `prepack` step: `next build` leaves the static assets out of the standalone output, so `web/.next/static` is copied into `web/.next/standalone/web/.next/static` or the browser gets 404ing chunks and never hydrates.
- Selection: extra args pass through to mocha (`npm run test:e2e -- --grep "runs a command"`); `--keep` leaves the throwaway home behind for a direct `npm run e2e:mocha` rerun with `E2E_HOST_CLI=sdkck E2E_SDKCK_HOME=…`.
- **Plugin UI-leg (`test/e2e/plugins.e2e.test.ts`):** when a gitignored `.env` at the repo root carries sandbox credentials (same convention as the sdkck host suite; loaded without overriding the real environment), the host leg seeds each plugin's `default` auth profile through the CLI — `auth add` validates on save — and then executes live, read-only commands through the browser UI: jira/conni auth test + project/space list, bb auth test + workspace read (`E2E_WORKSPACE`), sentry auth test + org issue list (org slug derived from `SENTRY_URL`, override with `SENTRY_ORG`), trello auth test + board list, and `api` import of the public Vercel spec + list. Plugins without credentials skip; trello only exists when the script installed it; every failure message passes through secret redaction. Only read-shaped commands run against the live sandboxes.
- **The JIT ghost-entry constraint:** sdkck installs its JIT-pinned plugins lazily, on the first dispatch of one of their commands, but sdkck's shipped `oclif.manifest.json` already lists every JIT command with relative paths that do not exist inside the sdkck package. A long-running webui server builds its command cache once at startup, so a plugin installed only after the server started stays a ghost entry whose in-process execution (`/api/run`) always fails with ModuleLoadError — the CLI dispatch path recovers from the same ghosts (install, then re-find), the in-process path does not. `scripts/e2e.sh` therefore eagerly installs every plugin the UI-leg executes (jira, conni, bb, sentry) before starting the server. A webui-side fallback (reload the config or dispatch through the host binary when a cached command fails to load) would fix this for real users and is a known follow-up.
- CI: `.github/workflows/run-e2e-tests.yml` runs both legs per push/PR — per-PR, unlike the sdkck host suite's nightly schedule, because nothing here requires secrets: without `.env` the plugin UI-leg skips entirely.
