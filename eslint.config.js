import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['**/dist', 'docs']),
  // Base TypeScript rules for all files
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      // Allow _-prefixed variables for intentional destructuring omission (e.g. const { x: _, ...rest } = obj)
      '@typescript-eslint/no-unused-vars': ['error', { varsIgnorePattern: '^_', argsIgnorePattern: '^_' }],
      // Allow `// @ts-nocheck` / `// @ts-expect-error` etc. when justified
      // with a description (>= 10 chars after the directive). The default
      // setting bans @ts-nocheck outright, which conflicts with the
      // tsconfig.server.json rollout that uses it as a known-debt marker.
      // The description requirement keeps the rule useful — drive-by
      // suppression is still flagged.
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-nocheck': 'allow-with-description',
          'ts-expect-error': 'allow-with-description',
          'ts-ignore': true,
          'ts-check': false,
          minimumDescriptionLength: 10,
        },
      ],
    },
  },
  // React Compiler / hooks rules only for frontend code
  // react-hooks v7+ performs deep data flow analysis — restrict to frontend to avoid
  // running it on server/cli/shared code that doesn't use React
  {
    files: ['frontend/**/*.{ts,tsx}'],
    extends: [
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    rules: {
      // Disable overly-strict React Compiler rules that flag legitimate patterns
      // (e.g., syncing local form state with async data, terminal ID syncing)
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/preserve-manual-memoization': 'off',
      // Allow exporting utilities alongside components (common shadcn/ui pattern)
      'react-refresh/only-export-components': 'off',
    },
  },
])
