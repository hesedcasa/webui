import type {Config} from '@oclif/core'
import type {IncomingMessage, ServerResponse} from 'node:http'

import {expect} from 'chai'

import {handleApi} from '../../src/lib/server.js'

interface MockResponse {
  body(): unknown
  end(data?: string): void
  headersSent: boolean
  status(): number
  writeHead(code: number): void
}

function makeConfig(
  overrides: Partial<{
    bin: string
    commands: unknown[]
    findCommand: (id: string) => unknown
    runCommand: (id: string, argv: string[]) => Promise<void>
    version: string
  }> = {},
): Config {
  return {
    bin: 'sdkck',
    commands: [],
    findCommand(_id: string) {},
    async runCommand(_id: string, _argv: string[]) {},
    version: '1.0.0',
    ...overrides,
  } as unknown as Config
}

function makeRes(): MockResponse {
  let statusCode = 200
  let rawBody = ''
  return {
    body() {
      try {
        return JSON.parse(rawBody)
      } catch {
        return rawBody
      }
    },
    end(data?: unknown) {
      rawBody = typeof data === 'string' ? data : ''
    },
    headersSent: false,
    status() {
      return statusCode
    },
    writeHead(code: number) {
      statusCode = code
    },
  }
}

function makeReq(method: string, url: string, body?: unknown): IncomingMessage {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  let index = 0

  async function* asyncIterator() {
    while (index < chunks.length) yield chunks[index++]
  }

  return {
    method,
    [Symbol.asyncIterator]: asyncIterator,
    url,
  } as unknown as IncomingMessage
}

describe('handleApi', () => {
  describe('GET /api/health', () => {
    it('returns 200 with ok:true', async () => {
      const res = makeRes()
      const handled = await handleApi(makeConfig(), makeReq('GET', '/api/health'), res as unknown as ServerResponse)
      expect(handled).to.be.true
      expect(res.status()).to.equal(200)
      expect(res.body()).to.deep.equal({ok: true})
    })
  })

  describe('GET /api/commands', () => {
    it('returns 200 with bin, version, and commands', async () => {
      const config = makeConfig({
        bin: 'mybin',
        commands: [
          {
            aliases: [],
            args: {},
            description: 'A test command',
            flags: {},
            hidden: false,
            id: 'greet',
          },
        ],
        version: '3.2.1',
      })
      const res = makeRes()
      await handleApi(config, makeReq('GET', '/api/commands'), res as unknown as ServerResponse)
      const b = res.body() as {bin: string; commands: Array<{id: string}>; version: string}
      expect(res.status()).to.equal(200)
      expect(b.bin).to.equal('mybin')
      expect(b.version).to.equal('3.2.1')
      expect(b.commands).to.have.length(1)
      expect(b.commands[0].id).to.equal('greet')
    })

    it('returns true (handled)', async () => {
      const res = makeRes()
      const handled = await handleApi(makeConfig(), makeReq('GET', '/api/commands'), res as unknown as ServerResponse)
      expect(handled).to.be.true
    })
  })

  describe('POST /api/run', () => {
    it('returns 400 when id is missing from the body', async () => {
      const res = makeRes()
      await handleApi(makeConfig(), makeReq('POST', '/api/run', {argv: []}), res as unknown as ServerResponse)
      expect(res.status()).to.equal(400)
      expect((res.body() as {error: string}).error).to.include('"id"')
    })

    it('returns 404 when the command id is not found', async () => {
      const config = makeConfig({findCommand() {}})
      const res = makeRes()
      await handleApi(config, makeReq('POST', '/api/run', {id: 'ghost'}), res as unknown as ServerResponse)
      expect(res.status()).to.equal(404)
      expect((res.body() as {error: string}).error).to.include('ghost')
    })

    it('returns 200 with command output on success', async () => {
      const config = makeConfig({
        findCommand: () => ({id: 'hello'}),
        async runCommand() {
          process.stdout.write('greetings\n')
        },
      })
      const res = makeRes()
      await handleApi(config, makeReq('POST', '/api/run', {argv: [], id: 'hello'}), res as unknown as ServerResponse)
      expect(res.status()).to.equal(200)
      const b = res.body() as {output: string; success: boolean}
      expect(b.success).to.be.true
      expect(b.output).to.equal('greetings\n')
    })

    it('passes argv to the command', async () => {
      const captured: string[][] = []
      const config = makeConfig({
        findCommand: () => ({id: 'cmd'}),
        async runCommand(_id, argv) {
          captured.push(argv)
        },
      })
      const res = makeRes()
      await handleApi(
        config,
        makeReq('POST', '/api/run', {argv: ['--name', 'world'], id: 'cmd'}),
        res as unknown as ServerResponse,
      )
      expect(captured[0]).to.deep.equal(['--name', 'world'])
    })

    it('treats non-array argv as empty', async () => {
      const captured: string[][] = []
      const config = makeConfig({
        findCommand: () => ({id: 'cmd'}),
        async runCommand(_id, argv) {
          captured.push(argv)
        },
      })
      const res = makeRes()
      await handleApi(
        config,
        makeReq('POST', '/api/run', {argv: 'not-an-array', id: 'cmd'}),
        res as unknown as ServerResponse,
      )
      expect(captured[0]).to.deep.equal([])
    })
  })

  describe('non-API routes', () => {
    it('returns false so the caller can pass the request to Next.js', async () => {
      const res = makeRes()
      const handled = await handleApi(makeConfig(), makeReq('GET', '/'), res as unknown as ServerResponse)
      expect(handled).to.be.false
    })

    it('returns false for any path without /api/ prefix', async () => {
      const res = makeRes()
      const handled = await handleApi(makeConfig(), makeReq('GET', '/dashboard'), res as unknown as ServerResponse)
      expect(handled).to.be.false
    })
  })

  describe('unknown API routes', () => {
    it('returns 404 for unknown paths under /api/', async () => {
      const res = makeRes()
      await handleApi(makeConfig(), makeReq('GET', '/api/unknown'), res as unknown as ServerResponse)
      expect(res.status()).to.equal(404)
    })

    it('returns true (handled) so the request is not forwarded', async () => {
      const res = makeRes()
      const handled = await handleApi(makeConfig(), makeReq('GET', '/api/nope'), res as unknown as ServerResponse)
      expect(handled).to.be.true
    })
  })
})
