import type {Command, Config} from '@oclif/core'

import {interpolateTemplate, listCommands} from '@hesed/plugin-lib'

/**
 * Serializable description of a single command flag, suitable for rendering a
 * form control in the web UI.
 */
interface FlagMeta {
  char?: string
  default?: unknown
  description?: string
  multiple: boolean
  name: string
  options?: string[]
  required: boolean
  type: 'boolean' | 'option'
}

/** Serializable description of a positional argument. */
interface ArgMeta {
  default?: unknown
  description?: string
  name: string
  options?: string[]
  required: boolean
}

/** Serializable description of a command, sent to the browser as JSON. */
interface CommandMeta {
  aliases: string[]
  args: ArgMeta[]
  description?: string
  flags: FlagMeta[]
  id: string
  pluginName?: string
  pluginType?: string
  summary?: string
  usage?: string | string[]
}

function renderMetadataText(value: string | undefined, config: Config, commandId: string): string | undefined {
  if (!value) return value
  return interpolateTemplate(value, {command: {id: commandId}, config})
}

function flagToMeta(name: string, flag: Command.Flag.Cached, config: Config, commandId: string): FlagMeta {
  const isBoolean = flag.type === 'boolean'
  return {
    char: flag.char,
    default: isBoolean ? undefined : (flag as {default?: unknown}).default,
    description: renderMetadataText(flag.summary ?? flag.description, config, commandId),
    multiple: !isBoolean && Boolean((flag as {multiple?: boolean}).multiple),
    name,
    options: isBoolean ? undefined : (flag as {options?: string[]}).options,
    required: Boolean(flag.required),
    type: isBoolean ? 'boolean' : 'option',
  }
}

function argToMeta(name: string, arg: Command.Arg.Cached, config: Config, commandId: string): ArgMeta {
  return {
    default: (arg as {default?: unknown}).default,
    description: renderMetadataText(arg.description, config, commandId),
    name,
    options: (arg as {options?: string[]}).options,
    required: Boolean(arg.required),
  }
}

/**
 * Build a serializable list of every visible command known to the oclif
 * {@link Config}, including dynamically registered ones.
 */
export function describeCommands(config: Config): CommandMeta[] {
  return listCommands(config)
    .filter((cmd) => !(cmd.id === 'webui' && cmd.pluginName === '@hesed/webui'))
    .map((cmd) => ({
      aliases: cmd.aliases ?? [],
      args: Object.entries(cmd.args ?? {}).map(([name, arg]) =>
        argToMeta(name, arg as Command.Arg.Cached, config, cmd.id),
      ),
      description: renderMetadataText(cmd.description, config, cmd.id),
      flags: Object.entries(cmd.flags ?? {})
        .filter(([, flag]) => !(flag as {hidden?: boolean}).hidden)
        .map(([name, flag]) => flagToMeta(name, flag as Command.Flag.Cached, config, cmd.id)),
      id: cmd.id,
      pluginName: cmd.pluginName,
      pluginType: cmd.pluginType,
      summary: renderMetadataText(cmd.summary, config, cmd.id),
      usage: Array.isArray(cmd.usage)
        ? cmd.usage.map((usage) => renderMetadataText(usage, config, cmd.id) ?? usage)
        : renderMetadataText(cmd.usage, config, cmd.id),
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
}
