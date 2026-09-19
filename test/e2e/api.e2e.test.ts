import {expect} from 'chai'

import {
  createConfigDir,
  expectOk,
  fetchJson,
  isSdkckLeg,
  removeConfigDir,
  runViaApi,
  startWebUi,
  stopWebUi,
  type WebUiServer,
} from './helpers.js'

describe('e2e: web UI JSON API', () => {
  let configDir: string
  let server: WebUiServer

  before(async () => {
    configDir = await createConfigDir()
    server = await startWebUi(configDir)
  })

  after(async () => {
    await stopWebUi(server)
    await removeConfigDir(configDir)
  })

  it('answers /api/health with ok:true', async () => {
    const result = await fetchJson<{ok: boolean}>(server, '/api/health')
    expectOk('GET /api/health', result)
    expect(result.body).to.deep.equal({ok: true})
  })

  it('reports the serving bin and version', async () => {
    const result = await fetchJson<{bin: string; version: string}>(server, '/api/commands')
    expectOk('GET /api/commands', result)
    expect(result.body.bin).to.equal(isSdkckLeg() ? 'sdkck' : 'webui')
    expect(result.body.version).to.be.a('string').and.to.not.equal('')
  })

  describe('GET /api/commands surface', () => {
    it('is empty on the standalone leg — the only command is webui itself, which is hidden', async function () {
      if (isSdkckLeg()) this.skip()

      const result = await fetchJson<{commands: unknown[]}>(server, '/api/commands')
      expectOk('GET /api/commands', result)
      expect(result.body.commands).to.deep.equal([])
    })

    it('lists the host commands on the sdkck leg, without webui itself', async function () {
      if (!isSdkckLeg()) this.skip()

      const result = await fetchJson<{commands: Array<{id: string}>}>(server, '/api/commands')
      expectOk('GET /api/commands', result)
      const ids = result.body.commands.map((command) => command.id)
      expect(ids, `host surface: ${JSON.stringify(ids)}`).to.include('synonyms:export')
      expect(ids).to.not.include('webui')
      expect(ids, 'commands must arrive sorted by id').to.deep.equal([...ids].sort((a, b) => a.localeCompare(b)))
    })
  })

  describe('POST /api/run', () => {
    it('returns 400 when the id is missing', async () => {
      const result = await fetchJson<{error: string}>(server, '/api/run', {
        body: JSON.stringify({argv: []}),
        headers: {'content-type': 'application/json'},
        method: 'POST',
      })
      expect(result.status).to.equal(400)
      expect(result.body.error).to.include('"id"')
    })

    it('returns 404 for an unknown command id', async () => {
      const result = await runViaApi(server, 'zzzzqqqqnope')
      expect(result.status).to.equal(404)
      expect(result.body.error).to.include('zzzzqqqqnope')
    })

    it('runs a host command in-process and returns its captured output', async function () {
      if (!isSdkckLeg()) this.skip()

      // `synonyms:export` is read-only and fully local: against the throwaway
      // config dir it has nothing stored, so its entire stdout is `[]` — a
      // deterministic round-trip from the browser API down into the host's
      // installed command.
      const result = await runViaApi(server, 'synonyms:export')
      expectOk('POST /api/run synonyms:export', result)
      expect(result.body.success).to.be.true
      expect(JSON.parse(result.body.output)).to.deep.equal([])
    })
  })

  it('404s unknown routes under /api/', async () => {
    const result = await fetchJson<{error: string}>(server, '/api/nope')
    expect(result.status).to.equal(404)
  })
})
