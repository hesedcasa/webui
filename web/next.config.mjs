import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'

// next is installed at the repo/plugin root, one level above web/.
// Both outputFileTracingRoot and turbopack.root must agree on this directory
// so that Turbopack can resolve next/package.json from web/app.
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** @type {import('next').NextConfig} */
const nextConfig = {
  distDir: '../dist/web',
  outputFileTracingRoot: root,
  reactStrictMode: true,
  turbopack: {
    root,
  },
}

export default nextConfig
