import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import { loadBoardConfig } from '../config.js';
import { execMutate, execRead } from '../exec.js';
import { PrSchema, renderPrHtml, type Pr } from '../templates/pr.js';

/** PRs are supported on Azure DevOps only for now (GitHub support deferred). */
function requireAzure(): void {
  const p = loadBoardConfig().provider;
  if (p !== 'azure') {
    throw new Error(
      `kodi pr requires the azure provider (current: "${p}"). Configure it with \`kodi init\`.`,
    );
  }
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

export function azureCreateArgs(pr: Pr, html: string, source: string, target: string, repo?: string): string[] {
  const args = [
    'az', 'repos', 'pr', 'create', '--title', pr.title, '--description', html,
    '--source-branch', source, '--target-branch', target,
  ];
  if (repo) args.push('--repository', repo);
  return args;
}

export function registerPrCommand(program: Command) {
  const pr = program.command('pr').description('Manage pull requests (proxy az) with a validated template');

  pr
    .command('create')
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
    .option('--repository <repo>', 'repository name')
    .option('--yes', 'execute (default: dry-run)', false)
    .action((o) => {
      requireAzure();
      const draft = draftFromOptions(o);
      const repo = o.repository ?? loadBoardConfig().repository;
      const args = azureCreateArgs(draft, renderPrHtml(draft), o.source, o.target, repo);
      const res = execMutate(args, !o.yes);
      if (res.ran) process.stdout.write((res.stdout.trim() || 'PR created') + '\n');
    });

  pr
    .command('list')
    .description('List open pull requests')
    .option('--repository <repo>')
    .action((o) => {
      requireAzure();
      const repo = o.repository ?? loadBoardConfig().repository;
      process.stdout.write(execRead(['az', 'repos', 'pr', 'list', ...(repo ? ['--repository', repo] : [])]));
    });

  pr
    .command('abandon <id>')
    .description('Abandon a pull request')
    .option('--yes', 'execute (default: dry-run)', false)
    .action((id, o) => {
      requireAzure();
      execMutate(['az', 'repos', 'pr', 'update', '--id', id, '--status', 'abandoned'], !o.yes);
    });

  return pr;
}

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}
