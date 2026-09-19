import {rmSync} from 'node:fs'

import {configDirForBaseUrl} from './helpers.js'

/**
 * Removes the throwaway oclif config dir the run's webServer used. On the
 * sdkck leg it ends up holding seeded auth profiles and imported specs, so it
 * must not outlive the run. Its path is derived from E2E_BASE_URL — the base
 * URL the webServer captured from the CLI's ready line.
 */
export default function globalTeardown(): void {
  const base = process.env.E2E_BASE_URL
  if (base) rmSync(configDirForBaseUrl(base), {force: true, recursive: true})
}
