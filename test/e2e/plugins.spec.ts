import {expect, test} from '@playwright/test'

import {
  isSdkckLeg,
  redactSecrets,
  runCommandViaUi,
  runHostCli,
  sharedBaseUrl,
  sharedConfigDir,
  startWebUi,
  stopWebUi,
  type SurfaceCommand,
  surfaceCommands,
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
 * Seeds one plugin's `default` auth profile into the run's config dir via the
 * CLI, which validates the credentials on save — a bad seed fails here, with a
 * redacted message, rather than as a confusing UI failure.
 *
 * @param configDir The throwaway config dir, from sharedConfigDir().
 * @param plugin The plugin topic, e.g. 'jira'.
 * @param fields Credential fields keyed by the plugin's auth add flag names.
 */
async function seedAuth(configDir: string, plugin: string, fields: Record<string, string>): Promise<void> {
  const argv = [plugin, 'auth', 'add', '--profile', 'default']
  for (const [name, value] of Object.entries(fields)) argv.push(`--${name}`, value)

  const result = await runHostCli(argv, configDir)
  expect(result.code, `seeding ${plugin} auth failed:\n${redactSecrets(result.output)}`).toBe(0)
}

/**
 * Imports one API spec into the run's config dir through the CLI.
 *
 * @param configDir The throwaway config dir, from sharedConfigDir().
 * @param source The spec URL to import.
 * @param flags Extra import flags, e.g. ['--name', 'linear'].
 */
async function importSpec(configDir: string, source: string, flags: string[]): Promise<void> {
  const result = await runHostCli(['api', 'import', source, ...flags], configDir)
  expect(result.code, `importing ${source} failed:\n${redactSecrets(result.output)}`).toBe(0)
}

/**
 * Seeds one imported spec's auth profile through the CLI.
 *
 * @param configDir The throwaway config dir, from sharedConfigDir().
 * @param argv The full `api auth add …` argv, credentials included.
 */
async function seedSpecAuth(configDir: string, argv: string[]): Promise<void> {
  const result = await runHostCli(argv, configDir)
  expect(result.code, `seeding spec auth failed:\n${redactSecrets(result.output)}`).toBe(0)
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
test.describe('e2e: executing plugin commands via the web UI', () => {
  test.skip(!isSdkckLeg(), 'sdkck host leg only')

  test.beforeEach(async ({page}) => {
    await page.goto('/')
  })

  test('serves the credential-backed plugins on its surface', async () => {
    const ids = (await surfaceCommands(sharedBaseUrl())).map((command) => command.id)
    for (const id of ['api:list', 'bb:auth:test', 'conni:auth:test', 'jira:auth:test', 'sentry:auth:test']) {
      expect(ids, `${id} missing from the served surface`).toContain(id)
    }
  })

  test.describe('jira', () => {
    test.skip(
      !hasCreds(['ATLASSIAN_API_TOKEN', 'ATLASSIAN_EMAIL', 'ATLASSIAN_URL']),
      'jira credentials not configured in .env',
    )

    test.beforeAll(async () => {
      await seedAuth(sharedConfigDir(), 'jira', {
        apiToken: process.env.ATLASSIAN_API_TOKEN!,
        email: process.env.ATLASSIAN_EMAIL!,
        host: process.env.ATLASSIAN_URL!,
      })
    })

    test('validates the stored profile through the UI', async ({page}) => {
      const result = await runCommandViaUi(page, 'jira:auth:test')
      expect(result.ok, result.output).toBe(true)
    })

    test('lists projects through the UI', async ({page}) => {
      const result = await runCommandViaUi(page, 'jira:project:list')
      expect(result.ok, result.output).toBe(true)
      expect(result.output, 'a live Jira instance has projects').not.toBe('')
    })
  })

  test.describe('conni', () => {
    test.skip(
      !hasCreds(['ATLASSIAN_API_TOKEN', 'ATLASSIAN_EMAIL', 'ATLASSIAN_URL']),
      'conni credentials not configured in .env',
    )

    test.beforeAll(async () => {
      await seedAuth(sharedConfigDir(), 'conni', {
        apiToken: process.env.ATLASSIAN_API_TOKEN!,
        email: process.env.ATLASSIAN_EMAIL!,
        host: process.env.ATLASSIAN_URL!,
      })
    })

    test('validates the stored profile through the UI', async ({page}) => {
      const result = await runCommandViaUi(page, 'conni:auth:test')
      expect(result.ok, result.output).toBe(true)
    })

    test('lists spaces through the UI', async ({page}) => {
      const result = await runCommandViaUi(page, 'conni:space:list')
      expect(result.ok, result.output).toBe(true)
    })
  })

  test.describe('bb', () => {
    test.skip(!hasCreds(['BITBUCKET_API_TOKEN', 'BITBUCKET_EMAIL']), 'bb credentials not configured in .env')

    test.beforeAll(async () => {
      // bb's API root is hardcoded to api.bitbucket.org; the legacy auth
      // schema still carries a host field, so seed it with the real root.
      await seedAuth(sharedConfigDir(), 'bb', {
        apiToken: process.env.BITBUCKET_API_TOKEN!,
        email: process.env.BITBUCKET_EMAIL!,
        host: 'https://api.bitbucket.org',
      })
    })

    test('validates the stored profile through the UI', async ({page}) => {
      const result = await runCommandViaUi(page, 'bb:auth:test')
      expect(result.ok, result.output).toBe(true)
    })

    test('reads the E2E_WORKSPACE through the UI form', async ({page}) => {
      const workspace = process.env.E2E_WORKSPACE
      test.skip(!workspace, 'E2E_WORKSPACE not configured in .env')

      // Fill the argument input the way the UI renders it: its id is
      // `arg-<name>` from the served metadata, not a guess.
      const commands = await surfaceCommands(sharedBaseUrl())
      const meta = commands.find((command) => command.id === 'bb:workspace')
      const argName = meta?.args[0]?.name
      expect(argName, 'bb:workspace exposes no argument').toBeTruthy()

      const result = await runCommandViaUi(page, 'bb:workspace', {[argName!]: workspace!})
      expect(result.ok, result.output).toBe(true)
      expect(result.output).toContain(workspace)
    })
  })

  test.describe('sentry', () => {
    test.skip(!hasCreds(['SENTRY_API_KEY']), 'sentry credentials not configured in .env')

    test.beforeAll(async () => {
      // The API root is the instance URL with /api/0 appended when missing.
      const raw = process.env.SENTRY_URL ?? 'https://sentry.io'
      const host = raw.endsWith('/api/0') ? raw : `${raw.replace(/\/+$/, '')}/api/0`
      await seedAuth(sharedConfigDir(), 'sentry', {
        authToken: process.env.SENTRY_API_KEY!,
        host,
        organization: sentryOrg(),
      })
    })

    test('validates the stored profile through the UI', async ({page}) => {
      const result = await runCommandViaUi(page, 'sentry:auth:test')
      expect(result.ok, result.output).toBe(true)
    })

    test("lists the organization's issues through the UI", async ({page}) => {
      // sentry:org reads the profile's organization — a real read through the
      // UI without needing a project slug.
      const result = await runCommandViaUi(page, 'sentry:org')
      expect(result.ok, result.output).toBe(true)
    })
  })

  test.describe('trello', () => {
    test.skip(!hasCreds(['TRELLO_API_KEY', 'TRELLO_SECRET']), 'trello credentials not configured in .env')

    // trello is not JIT-installed by the host; scripts/e2e.sh installs it only
    // when its credentials exist. Without that install the surface has no
    // trello commands — skip rather than fail. The check needs the running
    // server, so it happens in beforeAll and the tests guard on the result.
    let isSurfaceHasTrello = false

    test.beforeAll(async () => {
      const ids = (await surfaceCommands(sharedBaseUrl())).map((command) => command.id)
      isSurfaceHasTrello = ids.some((id) => id.startsWith('trello:'))
      if (!isSurfaceHasTrello) return

      await seedAuth(sharedConfigDir(), 'trello', {
        apiKey: process.env.TRELLO_API_KEY!,
        apiToken: process.env.TRELLO_SECRET!,
      })
    })

    test('validates the stored profile through the UI', async ({page}) => {
      test.skip(!isSurfaceHasTrello, 'trello not installed on this host')
      const result = await runCommandViaUi(page, 'trello:auth:test')
      expect(result.ok, result.output).toBe(true)
    })

    test('lists boards through the UI', async ({page}) => {
      test.skip(!isSurfaceHasTrello, 'trello not installed on this host')

      const commands = await surfaceCommands(sharedBaseUrl())
      expect(
        commands.some((command) => command.id === 'trello:board:list'),
        'trello:board:list missing from the served surface',
      ).toBe(true)

      const result = await runCommandViaUi(page, 'trello:board:list')
      expect(result.ok, result.output).toBe(true)
    })
  })

  test.describe('api', () => {
    // Imports only register operations in the throwaway config dir — no
    // external state. The credential-free smoke keeps the UI import flow
    // covered everywhere; the live calls below skip without their API keys.
    test('lists imported specs (none on a fresh config dir)', async ({page}) => {
      const result = await runCommandViaUi(page, 'api:list')
      expect(result.ok, result.output).toBe(true)
    })

    test('imports a public spec through the UI form', async ({page}) => {
      // The name is pinned: an omitted --name derives one from the spec, and
      // the live leg's auth seed below addresses the spec by this name.
      const result = await runCommandViaUi(page, 'api:import', {source: VERCEL_SPEC}, {name: 'vercel'})
      expect(result.ok, result.output).toBe(true)
    })

    test('lists the imported spec', async ({page}) => {
      const result = await runCommandViaUi(page, 'api:list')
      expect(result.ok, result.output).toBe(true)
      expect(result.output.toLowerCase()).toContain('vercel')
    })

    // The live api leg, mirroring the sdkck host suite's: import the Linear
    // GraphQL schema and the Context7 OpenAPI spec alongside the Vercel spec
    // the smoke imported, seed each spec's auth profile through the CLI (the
    // tokens must never pass through a browser form — screenshots would
    // capture them), then call one real operation per API through the UI.
    test.describe('live calls for every imported api', () => {
      test.skip(
        !hasCreds(['LINEAR_API_KEY', 'VERCEL_API_KEY', 'CONTEXT7_API_KEY']),
        'api credentials not configured in .env',
      )

      let live: undefined | WebUiServer

      test.beforeAll(async () => {
        // The Linear GraphQL SDL alone is several MB and every import
        // converts its spec, so the hook gets a generous timeout.
        test.setTimeout(600_000)

        const configDir = sharedConfigDir()
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

        // Dynamically registered spec commands (e.g. `linear viewer`) join the
        // surface only at server startup — the run's shared server built its
        // command cache before these imports — so the live runs execute
        // against a fresh server instance over the same config dir.
        live = await startWebUi(configDir)
      })

      test.afterAll(async () => {
        await stopWebUi(live)
      })

      test('lists all three imported specs through the UI', async ({page}) => {
        await page.goto(live!.url)

        const result = await runCommandViaUi(page, 'api:list')
        expect(result.ok, result.output).toBe(true)
        expect(result.output).toContain('linear')
        expect(result.output).toContain('vercel')
        expect(result.output).toContain('context7')
      })

      test('calls the linear viewer operation through the UI', async ({page}) => {
        await page.goto(live!.url)

        const result = await runCommandViaUi(page, 'api:call', {name: 'linear', operationId: 'viewer'})
        expect(result.ok, result.output).toBe(true)

        const payload = parseCallOutput<{data: {viewer: {id: string}}}>(result.output)
        expect(payload.data.viewer.id).toBeTruthy()
        expect(payload.data.viewer.id.length).toBeGreaterThanOrEqual(8)
      })

      test('calls the vercel getAuthUser operation through the UI', async ({page}) => {
        await page.goto(live!.url)

        const result = await runCommandViaUi(page, 'api:call', {name: 'vercel', operationId: 'getAuthUser'})
        expect(result.ok, result.output).toBe(true)

        const payload = parseCallOutput<{user: {username: string}}>(result.output)
        expect(payload.user.username).toBeTruthy()
        expect(payload.user.username.length).toBeGreaterThanOrEqual(1)
      })

      test('calls the context7 searchLibraries operation through the UI', async ({page}) => {
        await page.goto(live!.url)

        // Required query params ride the repeatable --param flag; the form
        // splits the comma-separated input into repeats.
        const result = await runCommandViaUi(
          page,
          'api:call',
          {name: 'context7', operationId: 'searchLibraries'},
          {param: 'libraryName=react,query=hooks'},
        )
        expect(result.ok, result.output).toBe(true)

        const payload = parseCallOutput<{results: Array<{id: string}>}>(result.output)
        expect(payload.results.length).toBeGreaterThanOrEqual(1)
      })

      test('calls the linear viewer operation directly through the UI', async ({page}) => {
        await page.goto(live!.url)

        // Dynamic operations register as `<specName>:<operationId>`; running
        // one directly must reach the same operation as api:call.
        const ids = (await surfaceCommands(live!.url)).map((command) => command.id)
        expect(ids, `linear ids: ${JSON.stringify(ids.filter((id) => id.startsWith('linear')))}`).toContain(
          'linear:viewer',
        )

        const result = await runCommandViaUi(page, 'linear:viewer')
        expect(result.ok, result.output).toBe(true)

        const payload = parseCallOutput<{data: {viewer: {id: string}}}>(result.output)
        expect(payload.data.viewer.id).toBeTruthy()
        expect(payload.data.viewer.id.length).toBeGreaterThanOrEqual(8)
      })

      test('calls the vercel getAuthUser operation directly through the UI', async ({page}) => {
        await page.goto(live!.url)

        const ids = (await surfaceCommands(live!.url)).map((command) => command.id)
        expect(ids, `vercel ids: ${JSON.stringify(ids.filter((id) => id.startsWith('vercel')))}`).toContain(
          'vercel:getAuthUser',
        )

        const result = await runCommandViaUi(page, 'vercel:getAuthUser')
        expect(result.ok, result.output).toBe(true)

        const payload = parseCallOutput<{user: {username: string}}>(result.output)
        expect(payload.user.username).toBeTruthy()
        expect(payload.user.username.length).toBeGreaterThanOrEqual(1)
      })

      test('calls the context7 searchLibraries operation directly through the UI', async ({page}) => {
        await page.goto(live!.url)

        const commands = await surfaceCommands(live!.url)
        const meta = commands.find((command) => command.id === 'context7:searchLibraries')
        expect(meta, 'context7:searchLibraries missing from the served surface').toBeTruthy()

        // Required URL/body parameters become args in the dynamic form and
        // optional ones become flags — fill whichever the served metadata
        // carries each parameter in.
        const {args, flags} = paramsFor(meta!, {libraryname: 'react', query: 'hooks'})
        const result = await runCommandViaUi(page, 'context7:searchLibraries', args, flags)
        expect(result.ok, result.output).toBe(true)

        const payload = parseCallOutput<{results: Array<{id: string}>}>(result.output)
        expect(payload.results.length).toBeGreaterThanOrEqual(1)
      })

      test('removes an imported spec through the UI', async ({page}) => {
        await page.goto(live!.url)

        const result = await runCommandViaUi(page, 'api:remove', {name: 'context7'})
        expect(result.ok, result.output).toBe(true)

        const list = await runCommandViaUi(page, 'api:list')
        expect(list.ok, list.output).toBe(true)
        expect(list.output).not.toContain('context7')
      })
    })
  })
})
