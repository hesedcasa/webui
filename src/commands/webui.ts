import type {Config} from '@oclif/core'
import type {LoadOptions} from '@oclif/core/interfaces'

import {Command, Flags} from '@oclif/core'
import {spawn} from 'node:child_process'

import {startServer} from '../lib/server.js'

export default class WebUI extends Command {
  static description = 'Web UI to browse and execute commands'
  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --port 8080 --open',
    '<%= config.bin %> <%= command.id %> --host 0.0.0.0',
  ]
  static flags = {
    host: Flags.string({
      default: '127.0.0.1',
      description: 'Host interface to bind.',
    }),
    open: Flags.boolean({
      default: false,
      description: 'Open the UI in the default browser once the server is ready.',
    }),
    port: Flags.integer({
      char: 'p',
      default: 4040,
      description: 'Port to listen on.',
    }),
  }

  /**
   * oclif normally reloads a Config when a command comes from a different
   * oclif core installation. Preserve the host CLI's initialized Config so
   * commands registered dynamically by init hooks remain available to the UI.
   */
  static async run<T extends Command>(
    this: new (argv: string[], config: Config) => T,
    argv: string[] = [],
    options?: LoadOptions,
  ): Promise<ReturnType<T['run']>> {
    if (options && typeof options !== 'string' && 'runCommand' in options) {
      const command = new this(argv, options as Config)
      return (command as unknown as {_run(): Promise<ReturnType<T['run']>>})._run()
    }

    return super.run(argv, options) as Promise<ReturnType<T['run']>>
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(WebUI)

    this.log(`Starting web UI…`)

    const {url} = await startServer({
      config: this.config,
      host: flags.host,
      port: flags.port,
    })

    this.log(`\n  ▸ Web UI ready at ${url}`)
    this.log('  ▸ Press Ctrl+C to stop.\n')

    if (flags.open) this.openBrowser(url)

    // The HTTP server keeps the event loop alive; this promise never resolves,
    // so the command stays running until the user interrupts it.
    await new Promise<void>(() => {})
  }

  private openBrowser(url: string): void {
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
    try {
      spawn(command, args, {detached: true, stdio: 'ignore'}).unref()
    } catch {
      // Opening a browser is best-effort; the URL is already printed.
    }
  }
}
