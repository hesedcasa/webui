import type {Page} from '@playwright/test'

import {type ChildProcess, execFile, spawn} from 'node:child_process'
import {existsSync} from 'node:fs'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {promisify} from 'node:util'

const execFileAsync = promisify(execFile)

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const SDKCK = path.join(REPO_ROOT, 'node_modules', '.bin', 'sdkck')

/**
 * Loads `<repo root>/.env` (gitignored) into the environment, without
 * overriding variables that are already set — the sdkck host suite's
 * convention for keeping secrets out of the repo while letting a local run
 * exercise the credential-backed plugins. Values of secret-looking keys are
 * remembered so redactSecrets() can keep them out of failure messages.
 *
 * playwright.config.ts imports this module before spawning the server, which
 * puts the variables in place for both the server subprocess and the tests.
 * No .env means the credential-backed plugin suite skips itself.
 */
const loadedSecrets: string[] = []

try {
  const dotEnv = await fs.readFile(path.join(REPO_ROOT, '.env'), 'utf8')
  for (const line of dotEnv.split('\n')) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim())
    if (!match) continue
    const [, key, raw] = match
    process.env[key] ??= raw.replaceAll(/^['"]|['"]$/g, '')
    if (/TOKEN|SECRET|KEY|PASSWORD/.test(key)) loadedSecrets.push(process.env[key]!)
  }
} catch {
  // No .env at the repo root — nothing to load.
}

/**
 * Replaces every loaded secret with *** so failure messages can include
 * command output without leaking credentials into logs.
 *
 * @param text Text that may contain secrets, e.g. captured command output.
 * @returns The redacted text.
 */
export function redactSecrets(text: string): string {
  let redacted = text
  for (const secret of loadedSecrets) {
    if (secret.length >= 8) redacted = redacted.replaceAll(secret, '***')
  }

  return redacted
}

export type WebUiServer = {
  proc: ChildProcess
  url: string
}

/** A JSON API response: the HTTP status and the parsed payload. */
export type JsonResponse<T> = {
  body: T
  status: number
}

/**
 * Whether the suite is running the sdkck-host leg rather than the standalone
 * one.
 *
 * Set by scripts/e2e.sh (and the CI workflow) after this build has been packed
 * and installed as the host's `@hesed/webui` plugin. When false, the config's
 * webServer and startWebUi drive the built standalone CLI instead.
 */
export function isSdkckLeg(): boolean {
  return process.env.E2E_HOST_CLI === 'sdkck'
}

/**
 * The bin name the UI reports for the configured leg.
 *
 * The brand and the command preview are rendered from `/api/commands`' `bin`,
 * which is the oclif config's bin: this plugin's own bin standalone, the
 * host's bin through sdkck.
 */
export function expectedBin(): string {
  return isSdkckLeg() ? 'sdkck' : 'webui'
}

/**
 * The throwaway oclif config dir playwright.config.ts created for the run.
 *
 * All suites share it: the web UI reads no config itself, and the sdkck leg
 * seeds auth profiles and imports specs into it. Global teardown removes it.
 *
 * @returns Absolute path to the config dir.
 */
export function sharedConfigDir(): string {
  return configDirForBaseUrl(sharedBaseUrl())
}

/**
 * The base URL of the server playwright.config.ts's webServer manages.
 *
 * The webServer captures it from the CLI's `Web UI ready at <url>` line into
 * `E2E_BASE_URL` (see the `wait` named group in playwright.config.ts), so the
 * value is only available once the run's server is up.
 *
 * @returns Absolute base URL, e.g. 'http://127.0.0.1:49152'.
 */
export function sharedBaseUrl(): string {
  const url = process.env.E2E_BASE_URL
  if (!url) throw new Error('E2E_BASE_URL is required — the webServer sets it from the ready line')
  return url
}

/**
 * The throwaway oclif config dir for a server on the given port.
 *
 * Derived from the port rather than minted per process (Playwright workers
 * re-evaluate the config), so every process of a run computes the same path,
 * while concurrent runs — which always claim different ports — stay isolated.
 *
 * @param port The port the server serves on.
 * @returns Absolute path to the config dir.
 */
export function configDirForPort(port: number): string {
  return path.join(os.tmpdir(), `webui-e2e-${port}`)
}

/**
 * The throwaway oclif config dir for the server behind a base URL.
 *
 * @param baseUrl The server's base URL, e.g. sharedBaseUrl().
 * @returns Absolute path to the config dir.
 */
export function configDirForBaseUrl(baseUrl: string): string {
  return configDirForPort(Number(new URL(baseUrl).port))
}

/**
 * Claims an unused TCP port by binding an ephemeral listener and releasing it.
 *
 * The `webui` command echoes the requested port in its ready line, so
 * `--port 0` would report a URL the browser cannot use, and the default 4040
 * may be the developer's own running web UI. The race between releasing the
 * port and the server binding it is small; if it loses, the server start fails
 * with the port named in the CLI's captured output.
 *
 * @returns A port number likely to be free on 127.0.0.1.
 */
export async function claimFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const {port} = server.address() as net.AddressInfo
      server.close(() => {
        resolve(port)
      })
    })
  })
}

/**
 * Builds the shell command and env overrides that serve the web UI through
 * the configured host CLI.
 *
 * By default the built standalone CLI (`bin/run.js`) runs with
 * `WEBUI_CONFIG_DIR` (oclif scopes that env var by bin name) pointed at the
 * run's throwaway config dir. When `E2E_HOST_CLI=sdkck`, the same arguments go
 * to the installed `sdkck` binary — this plugin's command id (`webui`) is
 * host-agnostic, so the argv needs no rewrite — and oclif's bin-scoped
 * `SDKCK_*` dirs are redirected into the throwaway sdkck home
 * (`E2E_SDKCK_HOME`) that scripts/e2e.sh installed this build into.
 *
 * playwright.config.ts hands the result to its webServer; startWebUi() spawns
 * the same command for suites that need a fresh server mid-run.
 *
 * @param port The port to serve on, from claimFreePort().
 * @param configDir Value for WEBUI_CONFIG_DIR / SDKCK_CONFIG_DIR.
 * @returns The shell command (relative to the repo root, the webServer's and
 *   the config's working directory) and env overrides to layer over
 *   process.env.
 */
export function webUiServerCommand(port: number, configDir: string): {command: string; env: Record<string, string>} {
  const base = {FORCE_COLOR: '0', NO_COLOR: '1'}

  if (isSdkckLeg()) {
    const home = process.env.E2E_SDKCK_HOME
    if (!home) {
      throw new Error('E2E_HOST_CLI=sdkck requires E2E_SDKCK_HOME — set by scripts/e2e.sh or the CI workflow')
    }

    if (!existsSync(SDKCK)) {
      throw new Error(`sdkck CLI not found at ${SDKCK} — install it first: npm install --no-save sdkck`)
    }

    return {
      command: `node_modules/.bin/sdkck webui --host 127.0.0.1 --port ${port}`,
      env: {
        ...base,
        SDKCK_CACHE_DIR: path.join(home, 'cache'),
        SDKCK_CONFIG_DIR: configDir,
        SDKCK_DATA_DIR: path.join(home, 'data'),
      },
    }
  }

  return {
    command: `node bin/run.js webui --host 127.0.0.1 --port ${port}`,
    env: {...base, WEBUI_CONFIG_DIR: configDir},
  }
}

/**
 * Sends a signal to the server's whole process group (spawned detached), so
 * any process that outlives the CLI itself cannot leak past the test run.
 *
 * @param proc The child process to signal.
 * @param signal The signal to send.
 */
function signalTree(proc: ChildProcess, signal: NodeJS.Signals): void {
  if (proc.pid === undefined) return

  try {
    process.kill(-proc.pid, signal)
  } catch {
    // The group is already gone (or pid reuse gave us a foreign one) — the
    // direct child may still be signalable, so fall back to it.
    proc.kill(signal)
  }
}

/**
 * Starts a web UI server as a real subprocess of the configured host CLI (see
 * webUiServerCommand()) and waits for its ready line.
 *
 * Used by suites that need a server with a command cache built *after* the
 * run's shared server started (the plugins suite's dynamically registered spec
 * commands); playwright.config.ts's webServer manages the shared one. A child
 * that exits — or stays silent — before announcing `Web UI ready at <url>`
 * rejects with the captured output.
 *
 * @param configDir Value for WEBUI_CONFIG_DIR / SDKCK_CONFIG_DIR, from
 *   sharedConfigDir().
 * @returns The running server: its child process and base URL.
 */
export async function startWebUi(configDir: string): Promise<WebUiServer> {
  const port = await claimFreePort()
  const {command, env} = webUiServerCommand(port, configDir)

  return new Promise((resolve, reject) => {
    const proc = spawn(command, {
      detached: true,
      env: {...process.env, ...env},
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let output = ''
    let isSettled = false

    const timer = setTimeout(() => {
      fail(`web UI server did not become ready within 60s:\n${output}`)
    }, 60_000)

    function fail(message: string): void {
      if (isSettled) return
      isSettled = true
      clearTimeout(timer)
      signalTree(proc, 'SIGKILL')
      reject(new Error(message))
    }

    proc.stdout!.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
      const ready = /Web UI ready at (\S+)/.exec(output)
      if (ready && !isSettled) {
        isSettled = true
        clearTimeout(timer)
        resolve({proc, url: ready[1]})
      }
    })

    proc.stderr!.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
    })

    proc.once('close', (code, signal) => {
      fail(`server exited before it was ready (code ${code}, signal ${signal}):\n${output}`)
    })
  })
}

/**
 * Stops a server started by startWebUi(): SIGTERM to the process group first,
 * escalating to SIGKILL after 5 s if it will not exit.
 *
 * @param server The server to stop, if the suite got as far as starting one.
 */
export async function stopWebUi(server?: WebUiServer): Promise<void> {
  if (!server) return
  const {proc} = server
  if (proc.exitCode !== null || proc.signalCode !== null) return

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signalTree(proc, 'SIGKILL')
    }, 5000)
    proc.once('close', () => {
      clearTimeout(timer)
      resolve()
    })
    signalTree(proc, 'SIGTERM')
  })
}

/**
 * Performs a JSON request against the given server's API.
 *
 * @param base The server's base URL, e.g. sharedBaseUrl().
 * @param pathname The API path, e.g. '/api/health'.
 * @param init Optional fetch options (method, body, headers).
 * @returns The HTTP status and the parsed JSON body.
 */
export async function fetchJson<T>(base: string, pathname: string, init?: RequestInit): Promise<JsonResponse<T>> {
  const response = await fetch(new URL(pathname, base), init)
  return {body: (await response.json()) as T, status: response.status}
}

export type CliResult = {
  code: number
  output: string
}

/**
 * Runs the installed sdkck host CLI as a real subprocess against the
 * throwaway home — the sdkck-leg sibling of the search suite's runCli().
 *
 * Used to seed auth profiles and import specs into the run's config dir: the
 * CLI validates credentials on save, so a bad seed fails here rather than in a
 * UI run.
 *
 * @param args Command line arguments, e.g. ['jira', 'auth', 'add', '--profile', 'default'].
 * @param configDir Value for SDKCK_CONFIG_DIR, from sharedConfigDir().
 * @returns The exit code and captured output (unredacted — redact before printing).
 */
export async function runHostCli(args: string[], configDir: string): Promise<CliResult> {
  const home = process.env.E2E_SDKCK_HOME
  if (!home) {
    throw new Error('runHostCli is sdkck-leg only — E2E_SDKCK_HOME is required (set by scripts/e2e.sh)')
  }

  try {
    const {stderr, stdout} = await execFileAsync(SDKCK, args, {
      env: {
        ...process.env,
        FORCE_COLOR: '0',
        NO_COLOR: '1',
        SDKCK_CACHE_DIR: path.join(home, 'cache'),
        SDKCK_CONFIG_DIR: configDir,
        SDKCK_DATA_DIR: path.join(home, 'data'),
      },
      maxBuffer: 32 * 1024 * 1024,
    })
    return {code: 0, output: stdout + stderr}
  } catch (error: unknown) {
    const failure = error as {code?: number; stderr?: string; stdout?: string}
    return {code: failure.code ?? 1, output: (failure.stdout ?? '') + (failure.stderr ?? '')}
  }
}

export type UiRunResult = {
  ok: boolean
  output: string
}

/**
 * Executes one command through the web UI the way a user would: click the
 * command in the sidebar, fill its argument and flag inputs, press Run, and
 * read the rendered status and output.
 *
 * @param page The browser page showing the app.
 * @param id The command id to click, e.g. 'jira:auth:test'.
 * @param args Argument values keyed by the command's argument names.
 * @param flags Flag values keyed by the command's flag names; a multiple
 *   flag takes comma-separated values, which the form splits into repeats.
 * @returns Whether the run succeeded and its captured output (secrets redacted).
 */
export async function runCommandViaUi(
  page: Page,
  id: string,
  args: Record<string, string> = {},
  flags: Record<string, string> = {},
): Promise<UiRunResult> {
  await page.locator('.command-item').first().waitFor({state: 'visible'})
  // Match the id exactly: substring matching would collide with sibling ids
  // like bb:workspace vs bb:workspace:list.
  await page
    .locator('.command-item')
    .filter({has: page.getByText(id, {exact: true})})
    .click()
  await page.locator('.detail h1').waitFor({state: 'visible'})

  for (const [name, value] of Object.entries(args)) {
    // Argument inputs fill in DOM order; Playwright serializes the actions.
    // eslint-disable-next-line no-await-in-loop
    await page.locator(`#arg-${name}`).fill(value)
  }

  for (const [name, value] of Object.entries(flags)) {
    // eslint-disable-next-line no-await-in-loop
    await page.locator(`#flag-${name}`).fill(value)
  }

  await page.locator('.run-btn').click()
  const status = page.locator('.detail .status')
  await status.waitFor({state: 'visible', timeout: 90_000})
  const ok = ((await status.getAttribute('class')) ?? '').includes('ok')
  const output = (await page.locator('.detail .output pre').textContent()) ?? ''
  return {ok, output: redactSecrets(output)}
}

export type SurfaceCommand = {
  args: Array<{name: string; required: boolean}>
  flags: Array<{name: string; required: boolean}>
  id: string
}

/**
 * Fetches the served command surface over real HTTP.
 *
 * @param base The server's base URL, e.g. sharedBaseUrl() or a fresh server's
 *   url from startWebUi().
 * @returns The served commands.
 */
export async function surfaceCommands(base: string): Promise<SurfaceCommand[]> {
  const {body} = await fetchJson<{commands: SurfaceCommand[]}>(base, '/api/commands')
  return body.commands
}
