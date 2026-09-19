import {type Config, defineConfig, devices} from '@playwright/test'
import {mkdirSync, rmSync} from 'node:fs'

import {claimFreePort, configDirForPort, webUiServerCommand} from './test/e2e/helpers.js'

// Importing helpers loads the gitignored .env into the environment (without
// overriding variables already set) before the server subprocess is spawned
// and before any test runs; helpers.ts tracks the loaded values for redaction.

// Playwright workers re-evaluate this file, but only the main process starts
// the webServer — skip the port claim and config-dir prep in workers.
const isWorker = process.env.TEST_WORKER_INDEX !== undefined

let webServer: Config['webServer']
if (!isWorker) {
  // The `webui` command echoes the requested port in its ready line, so
  // `--port 0` would announce a URL the browser cannot use — claim a real
  // free port instead. The claim-then-release race is small and loses loudly:
  // a lost race fails the server start with the port named in the CLI's
  // captured output.
  const port = await claimFreePort()

  // One throwaway oclif config dir for the whole run: the web UI reads no
  // config itself, so the dir starts empty and exists only so the CLI under
  // test never touches the developer's real sdkck/webui config. Its path is
  // derived from the port (see configDirForPort()) so workers computing it
  // agree with this process; a fresh run wipes any dir left by a crashed run
  // on a recycled port. Global teardown removes it.
  const configDir = configDirForPort(port)
  rmSync(configDir, {force: true, recursive: true})
  mkdirSync(configDir, {recursive: true})

  const {command, env} = webUiServerCommand(port, configDir)

  webServer = {
    command,
    env,
    gracefulShutdown: {signal: 'SIGTERM', timeout: 5000},
    // Never reuse a running server: a developer's own web UI would serve the
    // tests from their real config dir, which the sdkck leg writes into.
    reuseExistingServer: false,
    timeout: 120_000,
    // Readiness is the CLI's own ready line — its named group puts the served
    // URL into E2E_BASE_URL, where helpers and this config's baseURL read it.
    // Resolving on stdout (not a URL poll) also guarantees the env var is in
    // place before any worker forks.
    wait: {stdout: /Web UI ready at (?<e2e_base_url>\S+)/},
  }
}

export default defineConfig({
  forbidOnly: Boolean(process.env.CI),
  // The three suites share one server and one throwaway config dir, and the
  // sdkck leg seeds state into it (auth profiles, imported specs) — serial
  // execution keeps the runs deterministic.
  fullyParallel: false,
  globalTeardown: './test/e2e/global-teardown.ts',
  projects: [
    {
      name: 'chromium',
      use: {...devices['Desktop Chrome']},
    },
  ],
  reporter: [['list'], ['html', {open: 'never'}]],
  retries: process.env.CI ? 2 : 0,
  testDir: './test/e2e',
  timeout: 120_000,
  use: {
    // Only known at runtime: the webServer's wait named group sets it from
    // the ready line before workers fork.
    baseURL: process.env.E2E_BASE_URL,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer,
  workers: 1,
})
