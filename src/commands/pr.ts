import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { loadBoardConfig } from '../config.js';
import { execMutate, execRead } from '../exec.js';
import { PrSchema, renderPrHtml, renderPrMarkdown, type Pr } from '../templates/pr.js';

type Target = 'github' | 'azure';

/** Resolve the PR backend from an explicit flag or the active provider (local has none). */
function resolveTarget(explicit?: string): Target {
  if (explicit === 'github' || explicit === 'azure') return explicit;
  const p = loadBoardConfig().provider;
  if (p === 'github' || p === 'azure') return p;
  throw new Error(
    `no PR target: the active provider is "${p}". Configure github/azure with \`kodi init\`, or pass --provider.`,
  );
}

function draftFromOptions(o: Record<string, unknown>): Pr {
  if (o.file) return PrSchema.parse(JSON.parse(readFileSync(String(o.file), 'utf-8')));
  return PrSchema.parse({
    title: o.title,
    summary: o.summary,
    features: o.feature ?? [],
    fixes: o.fix ?? [],
    improvements: o.improvement ?? [],
    includedChanges: o.change ?? [],
    relatedIssues: o.issue ?? [],
    notes: o.notes,
    reviewers: o.reviewer ?? [],
  });
}

export function githubCreateArgs(
  pr: Pr,
  bodyFile: string,
  source: string,
  target: string,
  repo?: string,
): string[] {
  const args = [
    'gh',
    'pr',
    'create',
    '--title',
    pr.title,
    '--body-file',
    bodyFile,
    '--base',
    target,
    '--head',
    source,
  ];
  for (const r of pr.reviewers) args.push('--reviewer', r);
  if (repo) args.push('--repo', repo);
  return args;
}

export function azureCreateArgs(
  pr: Pr,
  html: string,
  source: string,
  target: string,
  repo?: string,
): string[] {
  const args = [
    'az',
    'repos',
    'pr',
    'create',
    '--title',
    pr.title,
    '--description',
    html,
    '--source-branch',
    source,
    '--target-branch',
    target,
  ];
  if (repo) args.push('--repository', repo);
  return args;
}

export function registerPrCommand(program: Command) {
  const pr = program
    .command('pr')
    .description('Manage pull requests (proxy gh/az) with a validated template');

  pr.command('create')
    .description('Create a PR from a validated template draft')
    .option('-f, --file <path>', 'JSON PR draft (validated against the template)')
    .option('-t, --title <title>')
    .option('-s, --summary <summary>')
    .option('--feature <text>', 'feature (repeatable)', collect, [])
    .option('--fix <text>', 'fix (repeatable)', collect, [])
    .option('--improvement <text>', 'improvement (repeatable)', collect, [])
    .option('--change <text>', 'included change (repeatable)', collect, [])
    .option('--issue <ref>', 'related issue (repeatable)', collect, [])
    .option('--reviewer <name>', 'reviewer (repeatable)', collect, [])
    .option('--notes <text>')
    .requiredOption('--source <branch>', 'branch the PR is opened from')
    .requiredOption('--target <branch>', 'branch the PR merges into')
    .option('--provider <github|azure>', 'override the PR provider')
    .option('--repository <repo>', 'repository (gh: OWNER/REPO; az: name)')
    .option('--yes', 'execute (default: dry-run)', false)
    .action((o) => {
      const draft = draftFromOptions(o);
      const target = resolveTarget(o.provider);
      const repo = o.repository ?? loadBoardConfig().repository;
      let args: string[];
      if (target === 'github') {
        const bodyFile = join(mkdtempSync(join(tmpdir(), 'kodi-pr-')), 'body.md');
        writeFileSync(bodyFile, renderPrMarkdown(draft), 'utf-8');
        args = githubCreateArgs(draft, bodyFile, o.source, o.target, repo);
      } else {
        args = azureCreateArgs(draft, renderPrHtml(draft), o.source, o.target, repo);
      }
      const res = execMutate(args, !o.yes);
      if (res.ran) process.stdout.write((res.stdout.trim() || 'PR created') + '\n');
    });

  pr.command('list')
    .description('List open pull requests')
    .option('--provider <github|azure>', 'override the PR provider')
    .option('--repository <repo>')
    .action((o) => {
      const target = resolveTarget(o.provider);
      const repo = o.repository ?? loadBoardConfig().repository;
      const args =
        target === 'github'
          ? ['gh', 'pr', 'list', ...(repo ? ['--repo', repo] : [])]
          : ['az', 'repos', 'pr', 'list', ...(repo ? ['--repository', repo] : [])];
      process.stdout.write(execRead(args));
    });

  pr.command('abandon <id>')
    .description('Abandon/close a pull request')
    .option('--provider <github|azure>', 'override the PR provider')
    .option('--repository <repo>')
    .option('--yes', 'execute (default: dry-run)', false)
    .action((id, o) => {
      const target = resolveTarget(o.provider);
      const repo = o.repository ?? loadBoardConfig().repository;
      const args =
        target === 'github'
          ? ['gh', 'pr', 'close', id, ...(repo ? ['--repo', repo] : [])]
          : ['az', 'repos', 'pr', 'update', '--id', id, '--status', 'abandoned'];
      execMutate(args, !o.yes);
    });

  return pr;
}

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}
