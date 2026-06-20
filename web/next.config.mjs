import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'

// next is installed at the repo/plugin root, one level above web/.
// Both outputFileTracingRoot and turbopack.root must agree on this directory
// so that Turbopack and the file tracer can resolve next/package.json.
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

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
