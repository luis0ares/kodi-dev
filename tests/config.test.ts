import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadBoardConfig } from '../src/config.js';
import { resolveProvider } from '../src/providers/index.js';

describe('loadBoardConfig', () => {
  let dir: string;
  const write = (yaml: string) => writeFileSync(join(dir, '.claude', 'kodi-dev.yaml'), yaml);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kodi-config-'));
    mkdirSync(join(dir, '.claude'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('refuses a github project instead of quietly writing local tickets', () => {
    write('provider: github\nrepository: acme/app\n');
    expect(() => loadBoardConfig(dir)).toThrow(/provider "github" is not supported/);
    expect(() => resolveProvider(dir)).toThrow(/Run `kodi init`/);
  });

  it('reads azure and local', () => {
    write('provider: azure\nproject: Beta\n');
    expect(loadBoardConfig(dir)).toMatchObject({ provider: 'azure', project: 'Beta' });
    write('provider: local\nprefix: ACME\n');
    expect(loadBoardConfig(dir)).toMatchObject({ provider: 'local', prefix: 'ACME' });
  });

  it('falls back to local when unconfigured or unreadable', () => {
    expect(loadBoardConfig(dir).provider).toBe('local');
    write('{ not: valid: yaml');
    expect(loadBoardConfig(dir).provider).toBe('local');
  });
});
