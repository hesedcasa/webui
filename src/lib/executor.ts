import type {Config} from '@oclif/core'

interface RunResult {
  durationMs: number
  error?: string
  output: string
  success: boolean
}

type WriteFn = typeof process.stdout.write

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

  const originalStdout = process.stdout.write
  const originalStderr = process.stderr.write
  process.stdout.write = makeCaptureFn(chunks)
  process.stderr.write = makeCaptureFn(chunks)

  const start = Date.now()
  let success = true
  let error: string | undefined

  try {
    await config.runCommand(id, argv)
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

  return {durationMs: Date.now() - start, error, output: chunks.join(''), success}
}
