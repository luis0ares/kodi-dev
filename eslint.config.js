// Flat ESLint config for the kodi CLI (Node/ESM, TypeScript 5.6).
// Scope: src/ + tests/. The board/ surface ships its own config later
// (ADR-0003 §2.2) and is ignored here so the two rule sets never bleed.
// Inert config: imports only from allowlisted tooling; no I/O, no env reads.

import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
  // Global ignores — board ships its own config; never lint build/output.
  {
    ignores: ['board/**', 'dist/**', 'node_modules/**', 'archive/**'],
  },

  // Base: typescript-eslint recommended (non-type-checked; lower-risk baseline
  // for a never-linted surface, per ADR-0003 §2.3 / task notes).
  ...tseslint.configs.recommended,

  // Correctness / security rules — ERRORS, never suppressed or downgraded.
  // typescript-eslint's non-type-checked recommended does not pull in ESLint's
  // core recommended set, so enable the security-class rules explicitly.
  // (The type-aware no-unsafe-* family requires the type-checked variant and is
  // deferred to the ratchet, per ADR-0003 §2.3 Phase B — not downgraded here.)
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    rules: {
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-prototype-builtins': 'error',
      'no-unsafe-negation': 'error',
      'no-unsafe-optional-chaining': 'error',
    },
  },

  // CLI source + tests: Node/ESM environment.
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        // Node globals used by the CLI.
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        fetch: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
      },
    },
    rules: {
      // Allow intentionally-unused, underscore-prefixed params (e.g. params
      // required by an implemented interface). Not a correctness downgrade.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },

  // Test-only relaxations (scoped to tests/, not a security downgrade).
  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },

  // Turn off ESLint stylistic rules that Prettier owns (must be last).
  eslintConfigPrettier,
);
