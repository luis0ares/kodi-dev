import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/**
 * The veracity score model (design: docs/memory-veracity-score.md). A memory's trust
 * is an integer 0–5, earned by surviving changes to its linked files and lost by being
 * refuted. These helpers are the deterministic half — hashing files to detect change
 * and mapping a score to an injection band; the *judgment* half lives in the agent.
 */

export const SCORE_FRESH = 3; // a new, agent-asserted but unverified claim
export const SCORE_MAX = 5;
export const SCORE_STALE_CAP = 2; // a needs-reverify memory drops here (out of inject)
export const AUTO_INJECT_MIN = 4; // 4–5: auto-inject as trusted fact
export const RELEVANCE_MIN = 3; // 3: inject only on strong relevance

export type Band = 'auto' | 'relevance' | 'ondemand';

/** Which injection band a score falls in. */
export function bandFor(score: number): Band {
  if (score >= AUTO_INJECT_MIN) return 'auto';
  if (score >= RELEVANCE_MIN) return 'relevance';
  return 'ondemand';
}

/** sha256 of a repo-relative (or absolute) file's contents; `'missing'` if unreadable. */
export function hashFile(root: string, relPath: string): string {
  const abs = isAbsolute(relPath) ? relPath : join(root, relPath);
  try {
    return createHash('sha256').update(readFileSync(abs)).digest('hex');
  } catch {
    return 'missing';
  }
}

/** Map every linked file to its current content hash. */
export function hashFiles(root: string, files: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of files) out[f] = hashFile(root, f);
  return out;
}

/** True if any linked file's current hash differs from the stored one (or is gone). */
export function anyFileChanged(root: string, fileHashes: Record<string, string> | null): boolean {
  if (!fileHashes) return false;
  for (const [path, stored] of Object.entries(fileHashes)) {
    if (hashFile(root, path) !== stored) return true;
  }
  return false;
}

/** Parse a stored `file_hashes` JSON blob; null/invalid → null. */
export function parseFileHashes(json: string | null | undefined): Record<string, string> | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as Record<string, string>;
  } catch {
    return null;
  }
}
