import {expect} from 'chai'
import {type ChildProcess, execFile, spawn} from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {promisify} from 'node:util'
import {type Browser, chromium, type Page} from 'playwright'

const execFileAsync = promisify(execFile)

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const CLI = path.join(REPO_ROOT, 'bin', 'run.js')
const SDKCK = path.join(REPO_ROOT, 'node_modules', '.bin', 'sdkck')

/**
 * Loads `<repo root>/.env` (gitignored) into the environment, without
 * overriding variables that are already set — the sdkck host suite's
 * convention for keeping secrets out of the repo while letting a local run
 * exercise the credential-backed plugins. Values of secret-looking keys are
 * remembered so redactSecrets() can keep them out of failure messages.
 *
 * No .env means the credential-backed plugin suites skip themselves.
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
  /** The bin name the UI brands itself with ('webui' standalone, 'sdkck' via the host). */
  bin: string
  proc: ChildProcess
  url: string
}

/** A JSON API response: the HTTP status and the parsed payload. */
export type JsonResponse<T> = {
  body: T
  status: number
}

/**
 * Whether the suite is running its second leg, through the sdkck host CLI.
 *
 * Set by scripts/e2e.sh (and the CI workflow) after this build has been packed
 * and installed as the host's `@hesed/webui` plugin. When false, startWebUi
 * drives the built standalone CLI instead.
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
 * Builds the subprocess invocation for the configured host CLI.
 *
 * By default the built standalone CLI (`bin/run.js`) runs with `WEBUI_CONFIG_DIR`
 * (oclif scopes that env var by bin name) pointed at a throwaway dir. When
 * `E2E_HOST_CLI=sdkck`, the same arguments go to the installed `sdkck` binary —
 * this plugin's command id (`webui`) is host-agnostic, so the argv needs no
 * rewrite — and oclif's bin-scoped `SDKCK_*` dirs are redirected into the
 * throwaway sdkck home (`E2E_SDKCK_HOME`) that scripts/e2e.sh installed this
 * build into.
 *
 * @param args Command line arguments, e.g. ['webui', '--port', '4040'].
 * @param configDir The dir the CLI writes config into, from createConfigDir().
 * @returns The executable, its argv, and env overrides to layer over
 *   process.env.
 */
function hostInvocation(
  args: string[],
  configDir: string,
): {argv: string[]; bin: string; command: string; env: Record<string, string>} {
  if (isSdkckLeg()) {
    const home = process.env.E2E_SDKCK_HOME
    if (!home) {
      throw new Error('E2E_HOST_CLI=sdkck requires E2E_SDKCK_HOME — set by scripts/e2e.sh or the CI workflow')
    }

    return {
      argv: args,
      bin: 'sdkck',
      command: SDKCK,
      env: {
        SDKCK_CACHE_DIR: path.join(home, 'cache'),
        SDKCK_CONFIG_DIR: configDir,
        SDKCK_DATA_DIR: path.join(home, 'data'),
      },
    }
  }

  return {argv: [CLI, ...args], bin: 'webui', command: process.execPath, env: {WEBUI_CONFIG_DIR: configDir}}
}

/**
 * Claims an unused TCP port by binding an ephemeral listener and releasing it.
 *
 * The `webui` command echoes the requested port in its ready line, so
 * `--port 0` would report a URL the browser cannot use, and the default 4040
 * may be the developer's own running web UI. The race between releasing the
 * port and the server binding it is small; if it loses, startWebUi fails with
 * the port named in the CLI's captured output.
 *
 * @returns A port number likely to be free on 127.0.0.1.
 */
export async function freePort(): Promise<number> {
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
 * Creates a throwaway oclif config dir for the suite to run against.
 *
 * The web UI reads no config itself — the dir starts empty and exists only so
 * the CLI under test never touches the developer's real sdkck/webui config.
 *
 * @returns Absolute path to the config dir, to be passed to startWebUi().
 */
export async function createConfigDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'webui-e2e-'))
}

/**
 * Removes a config dir written by createConfigDir().
 *
 * @param dir The directory to remove, if the suite got as far as creating one
 *   — an `after` hook also runs when its `before` skipped the suite.
 */
export async function removeConfigDir(dir?: string): Promise<void> {
  if (!dir) return
  await fs.rm(dir, {force: true, recursive: true})
}

let hasCleanedScreenshots = false

/**
 * The directory this leg's screenshots are written to, created on demand.
 *
 * Screenshots are run artifacts (gitignored): each executed browser test
 * captures its resulting page state, filed under a per-leg subdirectory so
 * the two legs' identically named tests never overwrite each other. The
 * first capture of a mocha process empties the directory first, so a run's
 * screenshots describe exactly that run.
 *
 * @returns Absolute path to the leg's screenshot directory.
 */
export async function screenshotDir(): Promise<string> {
  const dir = path.join(REPO_ROOT, 'test', 'e2e', 'screenshots', isSdkckLeg() ? 'sdkck' : 'standalone')

  if (!hasCleanedScreenshots) {
    hasCleanedScreenshots = true
    await fs.rm(dir, {force: true, recursive: true})
  }

  await fs.mkdir(dir, {recursive: true})
  return dir
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
 * Starts the web UI server as a real subprocess of the configured host CLI
 * (see hostInvocation()) and waits for its ready line.
 *
 * The `webui` command keeps the event loop alive forever, so the child is
 * expected to outlive this call; stopWebUi() must be called in the suite's
 * `after` hook. A child that exits — or stays silent — before announcing
 * `Web UI ready at <url>` rejects with the captured output.
 *
 * @param configDir Value for WEBUI_CONFIG_DIR / SDKCK_CONFIG_DIR, from
 *   createConfigDir().
 * @returns The running server: its bin name, child process and base URL.
 */
export async function startWebUi(configDir: string): Promise<WebUiServer> {
  const port = await freePort()
  const {argv, bin, command, env} = hostInvocation(['webui', '--host', '127.0.0.1', '--port', String(port)], configDir)

  return new Promise((resolve, reject) => {
    const proc = spawn(command, argv, {
      detached: true,
      env: {...process.env, FORCE_COLOR: '0', NO_COLOR: '1', ...env},
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

    proc.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
      const ready = /Web UI ready at (\S+)/.exec(output)
      if (ready && !isSettled) {
        isSettled = true
        clearTimeout(timer)
        resolve({bin, proc, url: ready[1]})
      }
    })

    proc.stderr.on('data', (chunk: Buffer) => {
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
 * @param server The server to stop, if the suite got as far as starting one
 *   — an `after` hook also runs when its `before` skipped the suite.
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
 * Launches a fresh headless Chromium for one suite.
 *
 * Each suite owns its browser so no cookies, localStorage or service-worker
 * state survives a suite boundary.
 *
 * @returns The launched browser, to be closed by the suite's `after` hook.
 */
export async function launchBrowser(): Promise<Browser> {
  return chromium.launch()
}

/**
 * Performs a JSON request against the running server's API.
 *
 * @param server The server to talk to.
 * @param pathname The API path, e.g. '/api/health'.
 * @param init Optional fetch options (method, body, headers).
 * @returns The HTTP status and the parsed JSON body.
 */
export async function fetchJson<T>(
  server: WebUiServer,
  pathname: string,
  init?: RequestInit,
): Promise<JsonResponse<T>> {
  const response = await fetch(new URL(pathname, server.url), init)
  return {body: (await response.json()) as T, status: response.status}
}

/**
 * The payload `/api/run` answers with: what the executor captured from the
 * command's stdout/stderr, whether it succeeded, and how long it took.
 */
export type RunResult = {
  durationMs: number
  error?: string
  output: string
  success: boolean
}

/**
 * Runs a command through `POST /api/run` and returns the executor's result.
 *
 * @param server The server to talk to.
 * @param id The command id, e.g. 'synonyms export'.
 * @param argv Arguments to pass to the command.
 * @returns The HTTP status and the run result payload.
 */
export async function runViaApi(
  server: WebUiServer,
  id: string,
  argv: string[] = [],
): Promise<JsonResponse<RunResult>> {
  return fetchJson(server, '/api/run', {
    body: JSON.stringify({argv, id}),
    headers: {'content-type': 'application/json'},
    method: 'POST',
  })
}

/**
 * Asserts a request succeeded, printing the response body on failure —
 * mirroring runCliOk() in API-shaped suites.
 *
 * @param label What the caller was doing, for the failure message.
 * @param result The status/body pair to check.
 */
export function expectOk<T>(label: string, result: JsonResponse<T>): void {
  expect(result.status, `${label} failed:\n${JSON.stringify(result.body, null, 2)}`).to.equal(200)
}

export type CliResult = {
  code: number
  output: string
}

/**
 * Runs the installed sdkck host CLI as a real subprocess against the
 * throwaway home — the sdkck-leg sibling of the search suite's runCli().
 *
 * Used to seed auth profiles into the throwaway config dir before the browser
 * tests execute commands in the host's process: `auth add` validates the
 * credentials on save, so a bad seed fails here rather than in a UI run.
 *
 * @param args Command line arguments, e.g. ['jira', 'auth', 'add', '--profile', 'default'].
 * @param configDir Value for SDKCK_CONFIG_DIR, from createConfigDir().
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

let screenshotIndex = 0

/**
 * Captures a full-page screenshot of the resulting page state, pass or fail,
 * numbered across the whole mocha process so one leg's screenshots sort in
 * execution order. A crashed page cannot be captured; the failure of the
 * capture itself must never mask the test result.
 *
 * @param page The browser page to capture.
 * @param state The mocha test state ('passed' or 'failed').
 * @param title The mocha test title, slugified into the filename.
 */
export async function captureScreenshot(page: Page, state: string, title: string): Promise<void> {
  screenshotIndex += 1
  const name = `${String(screenshotIndex).padStart(2, '0')}-${state === 'failed' ? 'FAIL' : 'PASS'}-${title.replaceAll(/[^\w]+/g, '-')}.png`

  try {
    await page.screenshot({fullPage: true, path: path.join(await screenshotDir(), name)})
  } catch {
    // A crashed page cannot be captured.
  }
}
