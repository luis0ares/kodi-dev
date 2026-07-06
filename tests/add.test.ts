import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installPack, mergeClaudeMd } from '../src/commands/add.js';

describe('mergeClaudeMd', () => {
  it('appends a managed block to empty content', () => {
    const out = mergeClaudeMd('', 'fastapi-backend', '- Backend: FastAPI');
    expect(out).toContain('<!-- kodi-pack:fastapi-backend -->');
    expect(out).toContain('- Backend: FastAPI');
    expect(out).toContain('<!-- /kodi-pack:fastapi-backend -->');
  });

  it('replaces its own block idempotently (no duplication)', () => {
    const once = mergeClaudeMd('# Contract\n', 'p', 'line-1');
    const twice = mergeClaudeMd(once, 'p', 'line-2');
    expect(twice.match(/<!-- kodi-pack:p -->/g)).toHaveLength(1);
    expect(twice).toContain('line-2');
    expect(twice).not.toContain('line-1');
    expect(twice).toContain('# Contract');
  });
});

describe('installPack', () => {
  let root: string;
  let pack: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'kodi-add-root-'));
    pack = mkdtempSync(join(tmpdir(), 'kodi-pack-'));
    writeFileSync(
      join(pack, 'manifest.yaml'),
      'name: fastapi-backend\nrole: backend\nframework: FastAPI\nclaude_md: |\n  - **Backend:** FastAPI (Python)\n  - **Backend gate:** ruff check . && pytest\n',
      'utf-8',
    );
    mkdirSync(join(pack, 'skills', 'fastapi-conventions'), { recursive: true });
    writeFileSync(join(pack, 'skills', 'fastapi-conventions', 'SKILL.md'), '---\nname: fastapi-conventions\n---\nbody\n', 'utf-8');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(pack, { recursive: true, force: true });
  });

  it('copies skills, merges CLAUDE.md, and records the pack', () => {
    const res = installPack(root, pack);
    expect(res.name).toBe('fastapi-backend');
    expect(existsSync(join(root, '.claude/skills/fastapi-conventions/SKILL.md'))).toBe(true);
    expect(readFileSync(join(root, 'CLAUDE.md'), 'utf-8')).toContain('**Backend:** FastAPI (Python)');
    expect(readFileSync(join(root, '.claude/kodi/packs.yaml'), 'utf-8')).toContain('fastapi-backend');
  });

  it('is idempotent — reinstalling does not duplicate the CLAUDE.md block or the pack record', () => {
    installPack(root, pack);
    installPack(root, pack);
    const claudeMd = readFileSync(join(root, 'CLAUDE.md'), 'utf-8');
    expect(claudeMd.match(/<!-- kodi-pack:fastapi-backend -->/g)).toHaveLength(1);
    const packs = readFileSync(join(root, '.claude/kodi/packs.yaml'), 'utf-8');
    expect(packs.match(/fastapi-backend/g)).toHaveLength(1);
  });
});
