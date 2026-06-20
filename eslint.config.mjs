import {includeIgnoreFile} from '@eslint/compat'
import oclif from 'eslint-config-oclif'
import prettier from 'eslint-config-prettier'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const gitignorePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '.gitignore')

export default [
  includeIgnoreFile(gitignorePath),
  {
    ignores: ['coverage/'],
  },
  ...oclif,
  prettier,
  {
    files: ['web/**/*.{ts,tsx}'],
    rules: {
      'n/no-unsupported-features/node-builtins': 'off',
    },
  },
]
