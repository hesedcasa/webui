import type {Browser, Page} from 'playwright'

import {expect} from 'chai'

import {
  captureScreenshot,
  createConfigDir,
  fetchJson,
  isSdkckLeg,
  launchBrowser,
  redactSecrets,
  removeConfigDir,
  runCommandViaUi,
  runHostCli,
  startWebUi,
  stopWebUi,
  type WebUiServer,
} from './helpers.js'

/**
 * The public spec imported through the UI to prove the `api` plugin's import
 * flow. Importing only registers operations in the throwaway config dir — it
 * touches no external state, and the spec URL needs no credentials.
 */
const VERCEL_SPEC = 'https://openapi.vercel.sh/'

/** The three live APIs of the api leg, with their spec sources. Mirrors the sdkck host suite. */
const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql'
const LINEAR_SCHEMA_URL =
  'https://raw.githubusercontent.com/linear/linear/refs/heads/master/packages/sdk/src/schema.graphql'
const CONTEXT7_SPEC_URL = 'https://raw.githubusercontent.com/upstash/context7/refs/heads/master/docs/openapi.json'

type SurfaceCommand = {
  args: Array<{name: string; required: boolean}>
  flags: Array<{name: string; required: boolean}>
  id: string
}

/** True when every named environment variable is set (loaded from .env). */
function hasCreds(names: string[]): boolean {
  return names.every((name) => process.env[name])
}

/**
 * The Sentry organization slug the connection test hits.
 *
 * .env carries no org slug; the instance subdomain is the best derivation,
 * overridable with SENTRY_ORG.
 */
function sentryOrg(): string {
  if (process.env.SENTRY_ORG) return process.env.SENTRY_ORG
  return new URL(process.env.SENTRY_URL ?? 'https://sentry.io').hostname.split('.', 1)[0] ?? 'sentry'
}

/**
 * Seeds one plugin's `default` auth profile into the throwaway config dir via
 * the CLI, which validates the credentials on save — a bad seed fails here,
 * with a redacted message, rather than as a confusing UI failure.
 *
 * @param configDir The throwaway config dir, from createConfigDir().
 * @param plugin The plugin topic, e.g. 'jira'.
 * @param fields Credential fields keyed by the plugin's auth add flag names.
 */
async function seedAuth(configDir: string, plugin: string, fields: Record<string, string>): Promise<void> {
  const argv = [plugin, 'auth', 'add', '--profile', 'default']
  for (const [name, value] of Object.entries(fields)) argv.push(`--${name}`, value)

  const result = await runHostCli(argv, configDir)
  expect(result.code, `seeding ${plugin} auth failed:\n${redactSecrets(result.output)}`).to.equal(0)
}

/**
 * Imports one API spec into the throwaway config dir through the CLI.
 *
 * @param configDir The throwaway config dir, from createConfigDir().
 * @param source The spec URL to import.
 * @param flags Extra import flags, e.g. ['--name', 'linear'].
 */
async function importSpec(configDir: string, source: string, flags: string[]): Promise<void> {
  const result = await runHostCli(['api', 'import', source, ...flags], configDir)
  expect(result.code, `importing ${source} failed:\n${redactSecrets(result.output)}`).to.equal(0)
}

/**
 * Seeds one imported spec's auth profile through the CLI.
 *
 * @param configDir The throwaway config dir, from createConfigDir().
 * @param argv The full `api auth add …` argv, credentials included.
 */
async function seedSpecAuth(configDir: string, argv: string[]): Promise<void> {
  const result = await runHostCli(argv, configDir)
  expect(result.code, `seeding spec auth failed:\n${redactSecrets(result.output)}`).to.equal(0)
}

async function surface(server: WebUiServer): Promise<SurfaceCommand[]> {
  const {body} = await fetchJson<{commands: SurfaceCommand[]}>(server, '/api/commands')
  return body.commands
}

/**
 * Parses the JSON body `api call` printed, skipping the `METHOD <url>` request
 * line it writes before the body.
 *
 * @param output The captured UI output of an api:call run.
 * @returns The parsed JSON payload.
 */
function parseCallOutput<T>(output: string): T {
  const body = /^(GET|POST|PUT|PATCH|DELETE) /.test(output) ? output.slice(output.indexOf('\n') + 1) : output
  return JSON.parse(body) as T
}

/**
 * Maps known parameter values onto a dynamic command's form inputs.
 *
 * Dynamic registration turns required URL/body parameters into args and
 * optional ones into flags, so each value goes wherever the served metadata
 * carries its parameter name (matched case-insensitively).
 *
 * @param meta The served command metadata for the dynamic command.
 * @param values Parameter values keyed by lowercased parameter name.
 * @returns Argument and flag values keyed by their declared names.
 */
function paramsFor(
  meta: SurfaceCommand,
  values: Record<string, string>,
): {args: Record<string, string>; flags: Record<string, string>} {
  const args: Record<string, string> = {}
  const flags: Record<string, string> = {}

  for (const arg of meta.args) {
    const value = values[arg.name.toLowerCase()]
    if (value !== undefined) args[arg.name] = value
  }

  for (const flag of meta.flags) {
    const value = values[flag.name.toLowerCase()]
    if (value !== undefined) flags[flag.name] = value
  }

  return {args, flags}
}

/**
 * Executes live, read-only commands through the web UI for every plugin the
 * local `.env` carries credentials for — the browser form is the only driver:
 * each run is a real click on Run against the host's installed plugins.
 *
 * Everything here is guarded to degrade gracefully: plugins whose credentials
 * are absent skip, trello (not JIT-installed by the host) skips unless
 * scripts/e2e.sh installed it, and every failure message is redacted. Only
 * read-shaped commands run — the suite executes against real sandboxes and
 * must leave them untouched.
 */
describe('e2e: executing plugin commands via the web UI', () => {
  let browser: Browser
  let configDir: string
  let page: Page
  let server: WebUiServer

  before(async function () {
    if (!isSdkckLeg()) this.skip()

    configDir = await createConfigDir()
    server = await startWebUi(configDir)
    browser = await launchBrowser()
    page = await browser.newPage()
  })

  after(async () => {
    await browser?.close()
    await stopWebUi(server)
    await removeConfigDir(configDir)
  })

  beforeEach(async () => {
    await page.goto(server.url)
  })

  // Screenshot record of every executed UI run — pass or fail.
  afterEach(async function () {
    const test = this.currentTest
    if (!test?.state) return
    await captureScreenshot(page, test.state, test.title)
  })

  it('serves the credential-backed plugins on its surface', async () => {
    const ids = (await surface(server)).map((command) => command.id)
    for (const id of ['api:list', 'bb:auth:test', 'conni:auth:test', 'jira:auth:test', 'sentry:auth:test']) {
      expect(ids, `${id} missing from the served surface`).to.include(id)
    }
  })

  describe('jira', () => {
    before(async function () {
      if (!hasCreds(['ATLASSIAN_API_TOKEN', 'ATLASSIAN_EMAIL', 'ATLASSIAN_URL'])) this.skip()
      await seedAuth(configDir, 'jira', {
        apiToken: process.env.ATLASSIAN_API_TOKEN!,
        email: process.env.ATLASSIAN_EMAIL!,
        host: process.env.ATLASSIAN_URL!,
      })
    })

    it('validates the stored profile through the UI', async () => {
      const result = await runCommandViaUi(page, 'jira:auth:test')
      expect(result.ok, result.output).to.be.true
    })

    it('lists projects through the UI', async () => {
      const result = await runCommandViaUi(page, 'jira:project:list')
      expect(result.ok, result.output).to.be.true
      expect(result.output, 'a live Jira instance has projects').to.not.equal('')
    })
  })

  describe('conni', () => {
    before(async function () {
      if (!hasCreds(['ATLASSIAN_API_TOKEN', 'ATLASSIAN_EMAIL', 'ATLASSIAN_URL'])) this.skip()
      await seedAuth(configDir, 'conni', {
        apiToken: process.env.ATLASSIAN_API_TOKEN!,
        email: process.env.ATLASSIAN_EMAIL!,
        host: process.env.ATLASSIAN_URL!,
      })
    })

    it('validates the stored profile through the UI', async () => {
      const result = await runCommandViaUi(page, 'conni:auth:test')
      expect(result.ok, result.output).to.be.true
    })

    it('lists spaces through the UI', async () => {
      const result = await runCommandViaUi(page, 'conni:space:list')
      expect(result.ok, result.output).to.be.true
    })
  })

  describe('bb', () => {
    before(async function () {
      // bb's API root is hardcoded to api.bitbucket.org; the legacy auth
      // schema still carries a host field, so seed it with the real root.
      if (!hasCreds(['BITBUCKET_API_TOKEN', 'BITBUCKET_EMAIL'])) this.skip()
      await seedAuth(configDir, 'bb', {
        apiToken: process.env.BITBUCKET_API_TOKEN!,
        email: process.env.BITBUCKET_EMAIL!,
        host: 'https://api.bitbucket.org',
      })
    })

    it('validates the stored profile through the UI', async () => {
      const result = await runCommandViaUi(page, 'bb:auth:test')
      expect(result.ok, result.output).to.be.true
    })

    it('reads the E2E_WORKSPACE through the UI form', async function () {
      const workspace = process.env.E2E_WORKSPACE
      if (!workspace) this.skip()

      // Fill the argument input the way the UI renders it: its id is
      // `arg-<name>` from the served metadata, not a guess.
      const commands = await surface(server)
      const meta = commands.find((command) => command.id === 'bb:workspace')
      const argName = meta?.args[0]?.name
      expect(argName, 'bb:workspace exposes no argument').to.exist

      const result = await runCommandViaUi(page, 'bb:workspace', {[argName!]: workspace})
      expect(result.ok, result.output).to.be.true
      expect(result.output).to.contain(workspace)
    })
  })

  describe('sentry', () => {
    before(async function () {
      if (!hasCreds(['SENTRY_API_KEY'])) this.skip()
      // The API root is the instance URL with /api/0 appended when missing.
      const raw = process.env.SENTRY_URL ?? 'https://sentry.io'
      const host = raw.endsWith('/api/0') ? raw : `${raw.replace(/\/+$/, '')}/api/0`
      await seedAuth(configDir, 'sentry', {
        authToken: process.env.SENTRY_API_KEY!,
        host,
        organization: sentryOrg(),
      })
    })

    it('validates the stored profile through the UI', async () => {
      const result = await runCommandViaUi(page, 'sentry:auth:test')
      expect(result.ok, result.output).to.be.true
    })

    it("lists the organization's issues through the UI", async () => {
      // sentry:org reads the profile's organization — a real read through the
      // UI without needing a project slug.
      const result = await runCommandViaUi(page, 'sentry:org')
      expect(result.ok, result.output).to.be.true
    })
  })

  describe('trello', () => {
    before(async function () {
      // trello is not JIT-installed by the host; scripts/e2e.sh installs it
      // only when its credentials exist. Without that install the surface has
      // no trello commands — skip rather than fail.
      if (!hasCreds(['TRELLO_API_KEY', 'TRELLO_SECRET'])) this.skip()

      const ids = (await surface(server)).map((command) => command.id)
      if (ids.every((id) => !id.startsWith('trello:'))) this.skip()

      await seedAuth(configDir, 'trello', {
        apiKey: process.env.TRELLO_API_KEY!,
        apiToken: process.env.TRELLO_SECRET!,
      })
    })

    it('validates the stored profile through the UI', async () => {
      const result = await runCommandViaUi(page, 'trello:auth:test')
      expect(result.ok, result.output).to.be.true
    })

    it('lists boards through the UI', async () => {
      const commands = await surface(server)
      const boardList = commands.find((command) => command.id === 'trello:board:list')
      expect(boardList, 'trello:board:list missing from the served surface').to.exist

      const result = await runCommandViaUi(page, 'trello:board:list')
      expect(result.ok, result.output).to.be.true
    })
  })

  describe('api', () => {
    // Imports only register operations in the throwaway config dir — no
    // external state. The credential-free smoke keeps the UI import flow
    // covered everywhere; the live calls below skip without their API keys.
    it('lists imported specs (none on a fresh config dir)', async () => {
      const result = await runCommandViaUi(page, 'api:list')
      expect(result.ok, result.output).to.be.true
    })

    it('imports a public spec through the UI form', async () => {
      // The name is pinned: an omitted --name derives one from the spec, and
      // the live leg's auth seed below addresses the spec by this name.
      const result = await runCommandViaUi(page, 'api:import', {source: VERCEL_SPEC}, {name: 'vercel'})
      expect(result.ok, result.output).to.be.true
    })

    it('lists the imported spec', async () => {
      const result = await runCommandViaUi(page, 'api:list')
      expect(result.ok, result.output).to.be.true
      expect(result.output.toLowerCase()).to.contain('vercel')
    })

    // The live api leg, mirroring the sdkck host suite's: import the Linear
    // GraphQL schema and the Context7 OpenAPI spec alongside the Vercel spec
    // the smoke imported, seed each spec's auth profile through the CLI (the
    // tokens must never pass through a browser form — screenshots would
    // capture them), then call one real operation per API through the UI.
    describe('live calls for every imported api', () => {
      before(async function () {
        // The Linear GraphQL SDL alone is several MB and every import
        // converts its spec, so the hook gets a generous timeout.
        this.timeout(600_000)
        if (!hasCreds(['LINEAR_API_KEY', 'VERCEL_API_KEY', 'CONTEXT7_API_KEY'])) this.skip()

        await importSpec(configDir, LINEAR_SCHEMA_URL, ['--name', 'linear', '--base-url', LINEAR_GRAPHQL_URL])
        await importSpec(configDir, CONTEXT7_SPEC_URL, ['--name', 'context7'])

        await seedSpecAuth(configDir, [
          'api',
          'auth',
          'add',
          'linear',
          '--type',
          'apikey',
          '--api-key',
          process.env.LINEAR_API_KEY!,
          '--api-key-header',
          'Authorization',
        ])
        await seedSpecAuth(configDir, [
          'api',
          'auth',
          'add',
          'vercel',
          '--type',
          'bearer',
          '--token',
          process.env.VERCEL_API_KEY!,
        ])
        await seedSpecAuth(configDir, [
          'api',
          'auth',
          'add',
          'context7',
          '--type',
          'bearer',
          '--token',
          process.env.CONTEXT7_API_KEY!,
        ])

        // Dynamically registered spec commands (e.g. `linear viewer`) join
        // the surface at host startup, so the server restarts against the
        // completed config dir before the UI runs.
        await stopWebUi(server)
        server = await startWebUi(configDir)
      })

      it('lists all three imported specs through the UI', async () => {
        const result = await runCommandViaUi(page, 'api:list')
        expect(result.ok, result.output).to.be.true
        expect(result.output).to.contain('linear')
        expect(result.output).to.contain('vercel')
        expect(result.output).to.contain('context7')
      })

      it('calls the linear viewer operation through the UI', async () => {
        const result = await runCommandViaUi(page, 'api:call', {name: 'linear', operationId: 'viewer'})
        expect(result.ok, result.output).to.be.true

        const payload = parseCallOutput(result.output) as {data: {viewer: {id: string}}}
        expect(payload.data.viewer.id).to.be.a('string').with.lengthOf.at.least(8)
      })

      it('calls the vercel getAuthUser operation through the UI', async () => {
        const result = await runCommandViaUi(page, 'api:call', {name: 'vercel', operationId: 'getAuthUser'})
        expect(result.ok, result.output).to.be.true

        const payload = parseCallOutput(result.output) as {user: {username: string}}
        expect(payload.user.username).to.be.a('string').with.lengthOf.at.least(1)
      })

      it('calls the context7 searchLibraries operation through the UI', async () => {
        // Required query params ride the repeatable --param flag; the form
        // splits the comma-separated input into repeats.
        const result = await runCommandViaUi(
          page,
          'api:call',
          {name: 'context7', operationId: 'searchLibraries'},
          {param: 'libraryName=react,query=hooks'},
        )
        expect(result.ok, result.output).to.be.true

        const payload = parseCallOutput(result.output) as {results: Array<{id: string}>}
        expect(payload.results).to.be.an('array').with.lengthOf.at.least(1)
      })

      it('calls the linear viewer operation directly through the UI', async () => {
        // Dynamic operations register as `<specName>:<operationId>`; running
        // one directly must reach the same operation as api:call.
        const ids = (await surface(server)).map((command) => command.id)
        expect(ids, `linear ids: ${JSON.stringify(ids.filter((id) => id.startsWith('linear')))}`).to.include(
          'linear:viewer',
        )

        const result = await runCommandViaUi(page, 'linear:viewer')
        expect(result.ok, result.output).to.be.true

        const payload = parseCallOutput(result.output) as {data: {viewer: {id: string}}}
        expect(payload.data.viewer.id).to.be.a('string').with.lengthOf.at.least(8)
      })

      it('calls the vercel getAuthUser operation directly through the UI', async () => {
        const ids = (await surface(server)).map((command) => command.id)
        expect(ids, `vercel ids: ${JSON.stringify(ids.filter((id) => id.startsWith('vercel')))}`).to.include(
          'vercel:getAuthUser',
        )

        const result = await runCommandViaUi(page, 'vercel:getAuthUser')
        expect(result.ok, result.output).to.be.true

        const payload = parseCallOutput(result.output) as {user: {username: string}}
        expect(payload.user.username).to.be.a('string').with.lengthOf.at.least(1)
      })

      it('calls the context7 searchLibraries operation directly through the UI', async () => {
        const commands = await surface(server)
        const meta = commands.find((command) => command.id === 'context7:searchLibraries')
        expect(meta, 'context7:searchLibraries missing from the served surface').to.exist

        // Required URL/body parameters become args in the dynamic form and
        // optional ones become flags — fill whichever the served metadata
        // carries each parameter in.
        const {args, flags} = paramsFor(meta!, {libraryname: 'react', query: 'hooks'})
        const result = await runCommandViaUi(page, 'context7:searchLibraries', args, flags)
        expect(result.ok, result.output).to.be.true

        const payload = parseCallOutput(result.output) as {results: Array<{id: string}>}
        expect(payload.results).to.be.an('array').with.lengthOf.at.least(1)
      })

      it('removes an imported spec through the UI', async () => {
        const result = await runCommandViaUi(page, 'api:remove', {name: 'context7'})
        expect(result.ok, result.output).to.be.true

        const list = await runCommandViaUi(page, 'api:list')
        expect(list.ok, list.output).to.be.true
        expect(list.output).to.not.contain('context7')
      })
    })
  })
})
