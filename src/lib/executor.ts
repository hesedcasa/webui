import type {Config} from '@oclif/core'

import stripAnsi from 'strip-ansi'

interface RunResult {
  durationMs: number
  error?: string
  output: string
  success: boolean
}

type WriteFn = typeof process.stdout.write

interface TopicRecord {
  description?: string
  name: string
}

/**
 * Init hooks can register commands after oclif has built its private topic
 * index. Help reads that index rather than deriving topics from
 * `config.commands`, so rebuild the missing command prefixes before execution.
 */
function refreshInferredTopics(config: Config): void {
  const topics = (config as unknown as {_topics?: Map<string, TopicRecord>})._topics
  if (!topics || !Array.isArray(config.commands)) return

  for (const command of config.commands) {
    if (command.hidden) continue

    const parts = command.id.split(':')
    while (parts.length > 0) {
      const name = parts.join(':')
      if (!topics.has(name)) topics.set(name, {description: command.summary ?? command.description, name})
      parts.pop()
    }
  }
}

/**
 * Execute an oclif command by id within the current process, capturing
 * everything it writes to stdout/stderr. Output is interleaved in write order
 * so the result reads like a real terminal session.
 *
 * Running in-process (rather than spawning a child) lets dynamically
 * registered commands — API operations, MCP client tools — run without the web
 * server needing to know how to re-invoke the host binary.
 */
function makeCaptureFn(chunks: string[]): WriteFn {
  return (chunk: unknown, encoding?: unknown, cb?: unknown): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'))
    const callback = typeof encoding === 'function' ? encoding : cb
    if (typeof callback === 'function') (callback as () => void)()
    return true
  }
}

export async function runCommand(config: Config, id: string, argv: string[]): Promise<RunResult> {
  const chunks: string[] = []

  refreshInferredTopics(config)

  const originalStdout = process.stdout.write
  const originalStderr = process.stderr.write
  process.stdout.write = makeCaptureFn(chunks)
  process.stderr.write = makeCaptureFn(chunks)

  const start = Date.now()
  let success = true
  let error: string | undefined

  try {
    // Instantiate the command directly with the existing config rather than going
    // through config.runCommand(), which calls the static Command.run() → Config.load()
    // internally. Config.load() rebuilds the config from scratch and loses dynamically
    // registered topics and commands (e.g. the jira topic from loaded user plugins).
    const cached = config.findCommand(id)
    if (!cached) throw new Error(`command ${id} not found`)
    const CommandClass = await cached.load()
    await config.runHook('prerun', {argv, Command: CommandClass})
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const instance = new (CommandClass as any)(argv, config)
    const result = await instance._run()
    await config.runHook('postrun', {argv, Command: CommandClass, result})
  } catch (error_) {
    success = false
    const message =
      error_ instanceof Error ? (error_.stack ?? error_.message) : typeof error_ === 'string' ? error_ : String(error_)
    error = message
    chunks.push(message.endsWith('\n') ? message : message + '\n')
  } finally {
    process.stdout.write = originalStdout
    process.stderr.write = originalStderr
  }

  return {
    durationMs: Date.now() - start,
    error: error ? stripAnsi(error) : undefined,
    output: stripAnsi(chunks.join('')),
    success,
  }
}
