import type {Config} from '@oclif/core'

import {expect} from 'chai'

import {describeCommands} from '../../src/lib/introspect.js'

type MockCommand = {
  aliases?: string[]
  args?: Record<string, unknown>
  description?: string
  flags?: Record<string, unknown>
  hidden?: boolean
  id: string
  pluginName?: string
  pluginType?: string
  summary?: string
  usage?: string | string[]
}

function makeConfig(commands: MockCommand[]): Config {
  return {commands} as unknown as Config
}

describe('describeCommands', () => {
  it('returns an empty array for an empty config', () => {
    const result = describeCommands(makeConfig([]))
    expect(result).to.deep.equal([])
  })

  it('filters out hidden commands', () => {
    const result = describeCommands(
      makeConfig([
        {aliases: [], args: {}, flags: {}, hidden: false, id: 'visible'},
        {aliases: [], args: {}, flags: {}, hidden: true, id: 'hidden'},
      ]),
    )
    expect(result).to.have.length(1)
    expect(result[0].id).to.equal('visible')
  })

  it('sorts commands alphabetically by id', () => {
    const result = describeCommands(
      makeConfig([
        {hidden: false, id: 'zzz'},
        {hidden: false, id: 'aaa'},
        {hidden: false, id: 'mmm'},
      ]),
    )
    expect(result.map((c) => c.id)).to.deep.equal(['aaa', 'mmm', 'zzz'])
  })

  describe('flag mapping', () => {
    it('maps a boolean flag', () => {
      const [cmd] = describeCommands(
        makeConfig([
          {
            flags: {verbose: {char: 'v', description: 'Be verbose', required: false, type: 'boolean'}},
            hidden: false,
            id: 'cmd',
          },
        ]),
      )
      const flag = cmd.flags.find((f) => f.name === 'verbose')!
      expect(flag.type).to.equal('boolean')
      expect(flag.char).to.equal('v')
      expect(flag.description).to.equal('Be verbose')
      expect(flag.required).to.be.false
      expect(flag.multiple).to.be.false
      expect(flag.default).to.be.undefined
      expect(flag.options).to.be.undefined
    })

    it('maps an option flag with all metadata', () => {
      const [cmd] = describeCommands(
        makeConfig([
          {
            flags: {
              format: {
                char: 'f',
                default: 'json',
                description: 'Output format',
                multiple: true,
                options: ['json', 'yaml'],
                required: true,
                type: 'option',
              },
            },
            hidden: false,
            id: 'cmd',
          },
        ]),
      )
      const flag = cmd.flags.find((f) => f.name === 'format')!
      expect(flag.type).to.equal('option')
      expect(flag.char).to.equal('f')
      expect(flag.description).to.equal('Output format')
      expect(flag.required).to.be.true
      expect(flag.multiple).to.be.true
      expect(flag.default).to.equal('json')
      expect(flag.options).to.deep.equal(['json', 'yaml'])
    })

    it('prefers summary over description for flag text', () => {
      const [cmd] = describeCommands(
        makeConfig([
          {
            flags: {name: {description: 'Long description', summary: 'Short summary', type: 'option'}},
            hidden: false,
            id: 'cmd',
          },
        ]),
      )
      expect(cmd.flags[0].description).to.equal('Short summary')
    })

    it('filters hidden flags', () => {
      const [cmd] = describeCommands(
        makeConfig([
          {
            flags: {
              secret: {hidden: true, type: 'option'},
              visible: {type: 'boolean'},
            },
            hidden: false,
            id: 'cmd',
          },
        ]),
      )
      expect(cmd.flags.map((f) => f.name)).to.deep.equal(['visible'])
    })

    it('includes multiple flags in order', () => {
      const [cmd] = describeCommands(
        makeConfig([
          {
            flags: {
              alpha: {type: 'boolean'},
              beta: {type: 'option'},
              gamma: {type: 'boolean'},
            },
            hidden: false,
            id: 'cmd',
          },
        ]),
      )
      expect(cmd.flags.map((f) => f.name)).to.deep.equal(['alpha', 'beta', 'gamma'])
    })
  })

  describe('arg mapping', () => {
    it('maps an arg with all metadata', () => {
      const [cmd] = describeCommands(
        makeConfig([
          {
            args: {
              file: {default: 'index.ts', description: 'Input file', options: ['a.ts', 'b.ts'], required: true},
            },
            hidden: false,
            id: 'cmd',
          },
        ]),
      )
      expect(cmd.args).to.have.length(1)
      const arg = cmd.args[0]
      expect(arg.name).to.equal('file')
      expect(arg.description).to.equal('Input file')
      expect(arg.required).to.be.true
      expect(arg.default).to.equal('index.ts')
      expect(arg.options).to.deep.equal(['a.ts', 'b.ts'])
    })

    it('maps multiple args in order', () => {
      const [cmd] = describeCommands(
        makeConfig([
          {
            args: {first: {required: true}, second: {required: false}},
            hidden: false,
            id: 'cmd',
          },
        ]),
      )
      expect(cmd.args.map((a) => a.name)).to.deep.equal(['first', 'second'])
    })
  })

  describe('command metadata', () => {
    it('includes all command fields', () => {
      const [cmd] = describeCommands(
        makeConfig([
          {
            aliases: ['mc'],
            description: 'Does something useful',
            hidden: false,
            id: 'my:cmd',
            pluginName: 'my-plugin',
            pluginType: 'core',
            summary: 'Short summary',
            usage: 'my:cmd [flags]',
          },
        ]),
      )
      expect(cmd.id).to.equal('my:cmd')
      expect(cmd.aliases).to.deep.equal(['mc'])
      expect(cmd.description).to.equal('Does something useful')
      expect(cmd.summary).to.equal('Short summary')
      expect(cmd.usage).to.equal('my:cmd [flags]')
      expect(cmd.pluginName).to.equal('my-plugin')
      expect(cmd.pluginType).to.equal('core')
    })

    it('accepts array usage', () => {
      const [cmd] = describeCommands(makeConfig([{hidden: false, id: 'cmd', usage: ['cmd --flag', 'cmd --other']}]))
      expect(cmd.usage).to.deep.equal(['cmd --flag', 'cmd --other'])
    })
  })
})
