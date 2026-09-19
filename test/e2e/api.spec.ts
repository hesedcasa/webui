import {expect, test} from '@playwright/test'

import {expectedBin, isSdkckLeg} from './helpers.js'

test.describe('e2e: web UI JSON API', () => {
  test('answers /api/health with ok:true', async ({request}) => {
    const response = await request.get('/api/health')
    expect(response.status()).toBe(200)
    expect(await response.json()).toEqual({ok: true})
  })

  test('reports the serving bin and version', async ({request}) => {
    const response = await request.get('/api/commands')
    expect(response.status()).toBe(200)
    const body = await response.json()
    expect(body.bin).toBe(expectedBin())
    expect(typeof body.version).toBe('string')
    expect(body.version).not.toBe('')
  })

  test.describe('GET /api/commands surface', () => {
    test('is empty on the standalone leg — the only command is webui itself, which is hidden', async ({request}) => {
      test.skip(isSdkckLeg(), 'standalone leg only')

      const response = await request.get('/api/commands')
      expect(response.status()).toBe(200)
      expect((await response.json()).commands).toEqual([])
    })

    test('lists the host commands on the sdkck leg, without webui itself', async ({request}) => {
      test.skip(!isSdkckLeg(), 'sdkck host leg only')

      const response = await request.get('/api/commands')
      expect(response.status()).toBe(200)
      const ids = (await response.json()).commands.map((command: {id: string}) => command.id) as string[]
      expect(ids, `host surface: ${JSON.stringify(ids)}`).toContain('synonyms:export')
      expect(ids).not.toContain('webui')
      expect(ids, 'commands must arrive sorted by id').toEqual([...ids].sort((a, b) => a.localeCompare(b)))
    })
  })

  test.describe('POST /api/run', () => {
    test('returns 400 when the id is missing', async ({request}) => {
      const response = await request.post('/api/run', {data: {argv: []}})
      expect(response.status()).toBe(400)
      expect((await response.json()).error).toContain('"id"')
    })

    test('returns 404 for an unknown command id', async ({request}) => {
      const response = await request.post('/api/run', {data: {argv: [], id: 'zzzzqqqqnope'}})
      expect(response.status()).toBe(404)
      expect((await response.json()).error).toContain('zzzzqqqqnope')
    })

    test('runs a host command in-process and returns its captured output', async ({request}) => {
      test.skip(!isSdkckLeg(), 'sdkck host leg only')

      // `synonyms:export` is read-only and fully local: against the throwaway
      // config dir it has nothing stored, so its entire stdout is `[]` — a
      // deterministic round-trip from the browser API down into the host's
      // installed command.
      const response = await request.post('/api/run', {data: {argv: [], id: 'synonyms:export'}})
      expect(response.status()).toBe(200)
      const body = await response.json()
      expect(body.success).toBe(true)
      expect(JSON.parse(body.output)).toEqual([])
    })
  })

  test('404s unknown routes under /api/', async ({request}) => {
    const response = await request.get('/api/nope')
    expect(response.status()).toBe(404)
  })
})
