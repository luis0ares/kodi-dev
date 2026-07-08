// Board-local flat ESLint config (ADR-0003 §2.2), separate from the CLI's
// root eslint.config.js. Next 16 removed `next lint`, so `pnpm -C board lint`
// invokes ESLint directly. eslint-config-next 16 ships NATIVE flat configs
// (arrays), so we spread them straight in — no FlatCompat shim needed.
//
// `core-web-vitals` already includes the base Next + React/JSX/hooks/a11y rules;
// `typescript` layers in the typescript-eslint recommended set.
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

const config = [
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    ignores: ['.next/**', 'node_modules/**', 'next-env.d.ts'],
  },
];

export default config;
