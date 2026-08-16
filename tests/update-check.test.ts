import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkForUpdate, isNewerVersion } from '../src/update-check.js';

describe('isNewerVersion', () => {
  it('compares major/minor/patch numerically', () => {
    expect(isNewerVersion('1.4.0', '1.3.2')).toBe(true);
    expect(isNewerVersion('2.0.0', '1.99.99')).toBe(true);
    expect(isNewerVersion('1.3.2', '1.3.2')).toBe(false);
    expect(isNewerVersion('1.3.1', '1.3.2')).toBe(false);
  });

  it('ignores a pre-release/build suffix', () => {
    expect(isNewerVersion('1.4.0-beta.1', '1.3.2')).toBe(true);
    expect(isNewerVersion('1.3.2', '1.3.2-rc.1')).toBe(false);
  });
});

let dir: string;
let cachePath: string;
let stderr: string[];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let spy: any;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kodi-update-test-'));
  cachePath = join(dir, 'update-check.json');
  stderr = [];
  spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => {
    stderr.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  spy.mockRestore();
  rmSync(dir, { recursive: true, force: true });
});

describe('checkForUpdate', () => {
  it('does nothing when disabled', async () => {
    const fetchLatest = vi.fn();
    await checkForUpdate('kodi-dev', '1.0.0', { disabled: true, cachePath, fetchLatest });
    expect(fetchLatest).not.toHaveBeenCalled();
    expect(stderr.join('')).toBe('');
  });

  it('skips the network call on a same-day cache hit', async () => {
    const now = 1_000_000;
    const fetchLatest = vi.fn().mockResolvedValue('9.9.9');
    // first call: stale cache -> fetches and writes
    await checkForUpdate('kodi-dev', '1.0.0', { cachePath, now: () => now, fetchLatest });
    expect(fetchLatest).toHaveBeenCalledTimes(1);
    // second call, same "day" -> no network call at all
    await checkForUpdate('kodi-dev', '1.0.0', { cachePath, now: () => now + 1000, fetchLatest });
    expect(fetchLatest).toHaveBeenCalledTimes(1);
  });

  it('re-checks once the cache is more than a day old', async () => {
    const fetchLatest = vi.fn().mockResolvedValue('1.0.0');
    const day = 24 * 60 * 60 * 1000;
    await checkForUpdate('kodi-dev', '1.0.0', { cachePath, now: () => 0, fetchLatest });
    await checkForUpdate('kodi-dev', '1.0.0', { cachePath, now: () => day + 1, fetchLatest });
    expect(fetchLatest).toHaveBeenCalledTimes(2);
  });

  it('auto-installs and reports success when a newer version is published', async () => {
    const fetchLatest = vi.fn().mockResolvedValue('2.0.0');
    const run = vi.fn().mockReturnValue({ status: 0 });
    await checkForUpdate('kodi-dev', '1.0.0', { cachePath, now: () => 0, fetchLatest, run });
    expect(run).toHaveBeenCalledWith(['npm', 'install', '-g', 'kodi-dev@latest']);
    expect(stderr.join('')).toMatch(/updated 1\.0\.0 -> 2\.0\.0/);
  });

  it('falls back to a manual-update reminder when the install itself fails', async () => {
    const fetchLatest = vi.fn().mockResolvedValue('2.0.0');
    const run = vi.fn().mockReturnValue({ status: 1 });
    await checkForUpdate('kodi-dev', '1.0.0', { cachePath, now: () => 0, fetchLatest, run });
    expect(stderr.join('')).toMatch(/automatic update failed/);
    expect(stderr.join('')).toMatch(/npm install -g kodi-dev@latest/);
  });

  it('prints nothing and never installs when already up to date', async () => {
    const fetchLatest = vi.fn().mockResolvedValue('1.0.0');
    const run = vi.fn();
    await checkForUpdate('kodi-dev', '1.0.0', { cachePath, now: () => 0, fetchLatest, run });
    expect(run).not.toHaveBeenCalled();
    expect(stderr.join('')).toBe('');
  });

  it('is silent (never throws, never installs) when the registry is unreachable', async () => {
    const fetchLatest = vi.fn().mockResolvedValue(null);
    const run = vi.fn();
    await expect(checkForUpdate('kodi-dev', '1.0.0', { cachePath, now: () => 0, fetchLatest, run })).resolves.toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });

  it('persists the checked-at timestamp and latest version to the cache file', async () => {
    const fetchLatest = vi.fn().mockResolvedValue('1.5.0');
    await checkForUpdate('kodi-dev', '1.5.0', { cachePath, now: () => 42, fetchLatest });
    expect(existsSync(cachePath)).toBe(true);
    expect(JSON.parse(readFileSync(cachePath, 'utf-8'))).toEqual({ checkedAt: 42, latest: '1.5.0' });
  });
});
