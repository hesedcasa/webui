import type {Config} from '@oclif/core'

import {expect} from 'chai'

import {runCommand} from '../../src/lib/executor.js'

function makeConfig(runFn: (id: string, argv: string[]) => Promise<void>): Config {
  return {
    findCommand(id: string) {
      return {
        async load() {
          class MockCommand {
            private argv: string[]

            constructor(argv: string[], _config: unknown) {
              this.argv = argv
            }

            async _run() {
              return runFn(id, this.argv)
            }
          }
          return MockCommand
        },
      }
    },
    async runHook() {
      return {failures: [], successes: []}
    },
  } as unknown as Config
}

describe('runCommand (executor)', () => {
  it('captures stdout', async () => {
    const config = makeConfig(async () => {
      process.stdout.write('hello stdout\n')
    })
    const result = await runCommand(config, 'test', [])
    expect(result.output).to.equal('hello stdout\n')
  })

  it('captures stderr', async () => {
    const config = makeConfig(async () => {
      process.stderr.write('hello stderr\n')
    })
    const result = await runCommand(config, 'test', [])
    expect(result.output).to.equal('hello stderr\n')
  })

  it('interleaves stdout and stderr in write order', async () => {
    const config = makeConfig(async () => {
      process.stdout.write('A')
      process.stderr.write('B')
      process.stdout.write('C')
    })
    const result = await runCommand(config, 'test', [])
    expect(result.output).to.equal('ABC')
  })

  it('captures Buffer writes as utf8 string', async () => {
    const config = makeConfig(async () => {
      process.stdout.write(Buffer.from('buffered\n'))
    })
    const result = await runCommand(config, 'test', [])
    expect(result.output).to.equal('buffered\n')
  })

  it('returns success=true when command completes normally', async () => {
    const config = makeConfig(async () => {})
    const result = await runCommand(config, 'test', [])
    expect(result.success).to.be.true
    expect(result.error).to.be.undefined
  })

  it('returns success=false when command throws', async () => {
    const config = makeConfig(async () => {
      throw new Error('boom')
    })
    const result = await runCommand(config, 'test', [])
    expect(result.success).to.be.false
  })

  it('sets error property to the error message on failure', async () => {
    const config = makeConfig(async () => {
      throw new Error('something went wrong')
    })
    const result = await runCommand(config, 'test', [])
    expect(result.error).to.include('something went wrong')
  })

  it('appends error output to the captured output', async () => {
    const config = makeConfig(async () => {
      process.stdout.write('before error\n')
      throw new Error('fatal')
    })
    const result = await runCommand(config, 'test', [])
    expect(result.output).to.include('before error\n')
    expect(result.output).to.include('fatal')
  })

  it('handles non-Error throws', async () => {
    const config = makeConfig(async () => {
      // eslint-disable-next-line no-throw-literal
      throw 'string error'
    })
    const result = await runCommand(config, 'test', [])
    expect(result.success).to.be.false
    expect(result.error).to.include('string error')
  })

  it('restores stdout.write to the same reference after a successful run', async () => {
    const original = process.stdout.write
    const config = makeConfig(async () => {})
    await runCommand(config, 'test', [])
    expect(process.stdout.write).to.equal(original)
  })

  it('restores stdout.write to the same reference after a failed run', async () => {
    const original = process.stdout.write
    const config = makeConfig(async () => {
      throw new Error('oops')
    })
    await runCommand(config, 'test', [])
    expect(process.stdout.write).to.equal(original)
  })

  it('restores stderr.write to the same reference after a run', async () => {
    const original = process.stderr.write
    const config = makeConfig(async () => {})
    await runCommand(config, 'test', [])
    expect(process.stderr.write).to.equal(original)
  })

  it('returns durationMs as a non-negative number', async () => {
    const config = makeConfig(async () => {})
    const result = await runCommand(config, 'test', [])
    expect(result.durationMs).to.be.a('number')
    expect(result.durationMs).to.be.gte(0)
  })

  it('passes the command id and argv to the command instance', async () => {
    const calls: Array<{argv: string[]; id: string}> = []
    const config = makeConfig(async (id, argv) => {
      calls.push({argv, id})
    })
    await runCommand(config, 'my:command', ['--flag', 'value'])
    expect(calls).to.have.length(1)
    expect(calls[0].id).to.equal('my:command')
    expect(calls[0].argv).to.deep.equal(['--flag', 'value'])
  })

  it('captures output from multiple commands sequentially', async () => {
    const config = makeConfig(async () => {
      process.stdout.write('run output\n')
    })
    const first = await runCommand(config, 'cmd', [])
    const second = await runCommand(config, 'cmd', [])
    expect(first.output).to.equal('run output\n')
    expect(second.output).to.equal('run output\n')
  })
})
