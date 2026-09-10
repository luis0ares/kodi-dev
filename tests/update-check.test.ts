import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkForUpdate, forceUpdate, isNewerVersion } from '../src/update-check.js';

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

describe('forceUpdate', () => {
  it('installs a newer version and reports it', async () => {
    const fetchLatest = vi.fn().mockResolvedValue('2.0.0');
    const run = vi.fn().mockReturnValue({ status: 0 });
    const res = await forceUpdate('kodi-dev', '1.0.0', {
      cachePath,
      now: () => 0,
      fetchLatest,
      run,
    });
    expect(run).toHaveBeenCalledWith(['npm', 'install', '-g', 'kodi-dev@latest']);
    expect(res).toEqual({ latest: '2.0.0', updated: true, alreadyLatest: false });
  });

  it('ignores a same-day cache — the whole point of asking for it explicitly', async () => {
    const fetchLatest = vi.fn().mockResolvedValue('1.0.0');
    await checkForUpdate('kodi-dev', '1.0.0', { cachePath, now: () => 0, fetchLatest });
    await forceUpdate('kodi-dev', '1.0.0', { cachePath, now: () => 1, fetchLatest });
    expect(fetchLatest).toHaveBeenCalledTimes(2);
  });

  it('does not reinstall when already on the latest version', async () => {
    const fetchLatest = vi.fn().mockResolvedValue('1.0.0');
    const run = vi.fn();
    const res = await forceUpdate('kodi-dev', '1.0.0', {
      cachePath,
      now: () => 0,
      fetchLatest,
      run,
    });
    expect(run).not.toHaveBeenCalled();
    expect(res).toEqual({ latest: '1.0.0', updated: false, alreadyLatest: true });
  });

  it('reinstalls the same version when asked to', async () => {
    const fetchLatest = vi.fn().mockResolvedValue('1.0.0');
    const run = vi.fn().mockReturnValue({ status: 0 });
    const res = await forceUpdate('kodi-dev', '1.0.0', {
      cachePath,
      now: () => 0,
      fetchLatest,
      run,
      reinstall: true,
    });
    expect(run).toHaveBeenCalledWith(['npm', 'install', '-g', 'kodi-dev@latest']);
    expect(res).toEqual({ latest: '1.0.0', updated: true, alreadyLatest: false });
  });

  it('reports a failed install rather than throwing', async () => {
    const fetchLatest = vi.fn().mockResolvedValue('2.0.0');
    const run = vi.fn().mockReturnValue({ status: 1 });
    const res = await forceUpdate('kodi-dev', '1.0.0', {
      cachePath,
      now: () => 0,
      fetchLatest,
      run,
    });
    expect(res).toEqual({ latest: '2.0.0', updated: false, alreadyLatest: false });
  });

  it('reports an unreachable registry and leaves the cache untouched', async () => {
    const fetchLatest = vi.fn().mockResolvedValue(null);
    const run = vi.fn();
    const res = await forceUpdate('kodi-dev', '1.0.0', {
      cachePath,
      now: () => 0,
      fetchLatest,
      run,
    });
    expect(res).toEqual({ latest: null, updated: false, alreadyLatest: false });
    expect(run).not.toHaveBeenCalled();
    expect(existsSync(cachePath)).toBe(false);
  });

  it('refreshes the shared cache so the ambient check does not redo the work today', async () => {
    const fetchLatest = vi.fn().mockResolvedValue('2.0.0');
    const run = vi.fn().mockReturnValue({ status: 0 });
    await forceUpdate('kodi-dev', '1.0.0', { cachePath, now: () => 42, fetchLatest, run });
    expect(JSON.parse(readFileSync(cachePath, 'utf-8'))).toEqual({
      checkedAt: 42,
      latest: '2.0.0',
    });
    await checkForUpdate('kodi-dev', '1.0.0', { cachePath, now: () => 43, fetchLatest, run });
    expect(fetchLatest).toHaveBeenCalledTimes(1);
  });
});
