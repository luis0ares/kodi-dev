import { describe, expect, it } from 'vitest';
import { execMutate, execRead } from '../src/exec.js';

// A binary that cannot exist on PATH, so the spawn never starts (status === null,
// error.code === 'ENOENT'). This is exactly the Windows `.cmd` failure mode that
// used to surface as the misleading "exit null".
const MISSING = 'kodi-nonexistent-binary-xyz';

describe('execRead', () => {
  it('runs a real read command and returns stdout', () => {
    const out = execRead(['node', '--version']);
    expect(out.trim()).toMatch(/^v\d+\./);
  });

  it('surfaces the spawn error code (not a bare "exit null") when the binary is unlaunchable', () => {
    // Regression guard: cross-spawn + exitReason() must report ENOENT so a missing
    // (or, on Windows, `.cmd`-only) binary is self-diagnosing rather than looking
    // like an auth/PATH problem on the user's side.
    expect(() => execRead([MISSING, '--x'])).toThrow(/ENOENT/);
    expect(() => execRead([MISSING, '--x'])).not.toThrow(/exit null/);
    // The offending command is echoed back for context.
    expect(() => execRead([MISSING])).toThrow(new RegExp(MISSING));
  });
});

describe('execMutate', () => {
  it('does NOT execute in dry-run — returns the previewed command, ran=false', () => {
    const res = execMutate([MISSING, 'delete', '--id', '7'], true);
    expect(res.ran).toBe(false);
    expect(res.command).toContain(MISSING);
    expect(res.stdout).toBe('');
  });

  it('executes with dryRun=false and captures stdout', () => {
    const res = execMutate(['node', '--version'], false);
    expect(res.ran).toBe(true);
    expect(res.code).toBe(0);
    expect(res.stdout.trim()).toMatch(/^v\d+\./);
  });

  it('surfaces the spawn error code when executing an unlaunchable binary', () => {
    expect(() => execMutate([MISSING, '--x'], false)).toThrow(/ENOENT/);
  });
});
