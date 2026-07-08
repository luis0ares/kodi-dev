import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Emit a self-contained server bundle (ADR-0002 §2.1) so the CLI can serve
  // the board without a node_modules tree at runtime.
  output: 'standalone',
  // Pin the Turbopack/file-tracing root to board/. Without this, Next walks up
  // and picks the repo-root lockfile, nesting standalone/ under board/ and
  // tracing files outside the board. Keeping the root here keeps the scaffold
  // self-contained (R-010).
  turbopack: {
    root: import.meta.dirname,
  },
  reactStrictMode: true,
  // Drop the version-leaking X-Powered-By header (security requirement).
  poweredByHeader: false,
  // NOTE: response security headers / CSP are wired with the served board in
  // KODI-011. Not faked here against an empty placeholder page.
};

export default nextConfig;
