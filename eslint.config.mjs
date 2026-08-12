import {includeIgnoreFile} from '@eslint/compat'
import oclif from 'eslint-config-oclif'
import prettier from 'eslint-config-prettier'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import tseslint from 'typescript-eslint'

const gitignorePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '.gitignore')

const config = [
  includeIgnoreFile(gitignorePath),
  {
    ignores: ['coverage/', 'dist/'],
  },
  ...oclif,
  // Disable type-checked (type-aware) rules for test files. Test fixtures and
  // mocks don't need full type information and shouldn't fail type-aware rules
  // such as no-unsafe-* / no-base-to-string. Mirrors plugin-lib#63.
  {
    files: ['test/**/*.ts'],
    ...tseslint.configs.disableTypeChecked,
  },
  // eslint.config.mjs references typescript-eslint, which is a transitive
  // dependency (via eslint-config-oclif) rather than a direct one — relax the
  // extraneous-dependency checks for this file only.
  {
    files: ['eslint.config.mjs'],
    rules: {
      'import-x/no-extraneous-dependencies': 'off',
      'n/no-extraneous-import': 'off',
    },
  },
  // Relax overly-strict rules from eslint-config-oclif@7 across the project.
  {
    rules: {
      // Buffer is the correct type for Node stream/file APIs used here
      '@typescript-eslint/no-restricted-types': 'off',
      'n/prefer-global/buffer': 'off',
      // Both tsconfigs target ES2022, where the `v` regex flag is unavailable
      'require-unicode-regexp': 'off',
    },
  },
  {
    files: ['src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      'unicorn/consistent-boolean-name': 'off',
      'unicorn/consistent-class-member-order': 'off',
      // `Array#toSorted()` (ES2023) isn't available at the ES2022 target
      'unicorn/no-array-sort': 'off',
    },
  },
  // The Next.js app under web/ is bundled by Next, which resolves extensionless
  // and JSX imports itself, and React event handlers legitimately return values
  // in void positions.
  {
    files: ['web/**/*.{ts,tsx}', 'web/*.mjs'],
    rules: {
      // Command metadata defaults are `unknown` and `||` is deliberate where an
      // empty description should fall through to the next value.
      '@typescript-eslint/no-base-to-string': 'off',
      '@typescript-eslint/no-confusing-void-expression': 'off',
      '@typescript-eslint/prefer-nullish-coalescing': 'off',
      '@typescript-eslint/strict-void-return': 'off',
      'n/file-extension-in-import': 'off',
    },
  },
  // Additional relaxations for test files only. These are pure style rules
  // that conflict with common test patterns (mock stubs, mock-tracking
  // booleans and the empty stubs used to silence command output).
  {
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-empty-function': 'off',
      // Mock commands must expose oclif's `_run` hook, so they can't use a
      // private class field, and iterator helpers aren't in the compiled lib.
      'unicorn/prefer-iterator-to-array': 'off',
      'unicorn/prefer-private-class-fields': 'off',
    },
  },
  prettier,
]

export default config
