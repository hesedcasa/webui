import {existsSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'

// Walk up from web/ to find the directory that owns the lockfile and node_modules.
// In dev this is the repo root; when installed as an oclif plugin this is the
// sdkck root (e.g. ~/.local/share/sdkck) — one level up from web/ would land
// inside node_modules/@hesed/webui which has no lockfile and the wrong next.
function findRoot(dir) {
  if (existsSync(join(dir, 'package-lock.json'))) return dir
  const parent = dirname(dir)
  if (parent === dir) return dir
  return findRoot(parent)
}

const root = findRoot(dirname(fileURLToPath(import.meta.url)))

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
