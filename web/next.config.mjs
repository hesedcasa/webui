import {existsSync} from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

// Walk up from web/ to find the directory that owns the lockfile and node_modules.
// In dev this is the repo root; when installed as an oclif plugin this is the
// sdkck root (e.g. ~/.local/share/sdkck) — one level up from web/ would land
// inside node_modules/@hesed/webui which has no lockfile and the wrong next.
function findRoot(startDir) {
  let dir = startDir
  while (!existsSync(path.join(dir, 'package-lock.json'))) {
    const parent = path.dirname(dir)
    if (parent === dir) return dir
    dir = parent
  }

  return dir
}

const root = findRoot(path.dirname(fileURLToPath(import.meta.url)))

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  outputFileTracingRoot: root,
  reactStrictMode: true,
  turbopack: {
    root,
  },
}

export default nextConfig
