import { defineConfig } from 'eslint/config'
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import eslintConfigPrettier from 'eslint-config-prettier'

export default defineConfig(
  {
    ignores: ['**/node_modules', '**/dist', '**/.wrangler']
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }]
    }
  },
  {
    // The playground is a Node harness, not Worker code — it gets Node globals.
    files: ['playground/**/*.mjs', 'eslint.config.mjs', '*.config.ts'],
    languageOptions: {
      globals: {
        Buffer: 'readonly',
        TextDecoder: 'readonly',
        TextEncoder: 'readonly',
        URL: 'readonly',
        clearInterval: 'readonly',
        clearTimeout: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        process: 'readonly',
        setInterval: 'readonly',
        setTimeout: 'readonly'
      }
    }
  },
  eslintConfigPrettier
)
