import {captureOutput, runCommand} from '@oclif/test'
import {expect} from 'chai'
import esmock from 'esmock'
import {dirname, join, sep} from 'node:path'
import {fileURLToPath} from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..', '..')

// esmock embeds the module path as a URL query-param. On Windows, path.join
// produces backslash paths that Node.js URL-encodes to %5C in the source hook,
// causing the esmockCacheGet key to mismatch the stored key. Forward slashes
// are safe in all URL contexts and also accepted by Node.js on Windows.
const fwdSlash = (p: string) => p.split(sep).join('/')

function mockStartServer(port: number) {
  return async () => ({
    server: {address: () => ({port})},
    url: `http://127.0.0.1:${port}`,
  })
}

async function loadWebUI(port = 14_040) {
  const {default: WebUI} = await esmock(fwdSlash(join(__dirname, '../../src/commands/webui.js')), {
    [fwdSlash(join(__dirname, '../../src/lib/server.ts'))]: {startServer: mockStartServer(port)},
  })
  return WebUI as typeof import('../../src/commands/webui.js').default
}

/** Run the webui command for up to 300 ms, then return whatever was logged. */
async function runWithTimeout(WebUI: Awaited<ReturnType<typeof loadWebUI>>, args: string[]) {
  return captureOutput(async () => {
    await Promise.race([
      WebUI.run(args),
      new Promise<void>((resolve) => {
        setTimeout(resolve, 300)
      }),
    ])
  })
}

describe('webui command', () => {
  describe('--help', () => {
    let helpOutput: string

    before(async () => {
      const {stdout} = await runCommand(['webui', '--help'], {root})
      helpOutput = stdout
    })

    it('includes the --port flag', () => {
      expect(helpOutput).to.include('--port')
    })

    it('includes the --host flag', () => {
      expect(helpOutput).to.include('--host')
    })

    it('includes the --open flag', () => {
      expect(helpOutput).to.include('--open')
    })

    it('shows the port default value', () => {
      expect(helpOutput).to.include('4040')
    })

    it('shows the host default value', () => {
      expect(helpOutput).to.include('127.0.0.1')
    })
  })

  describe('startup output', () => {
    it('logs the ready URL after the server starts', async () => {
      const WebUI = await loadWebUI(14_052)
      const {stdout} = await runWithTimeout(WebUI, ['--port', '14052'])
      expect(stdout).to.include('http://127.0.0.1:14052')
    })

    it('logs a Ctrl+C hint', async () => {
      const WebUI = await loadWebUI(14_053)
      const {stdout} = await runWithTimeout(WebUI, [])
      expect(stdout).to.include('Ctrl+C')
    })
  })
})
