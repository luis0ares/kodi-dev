import { Command } from 'commander';
import { forceUpdate } from '../update-check.js';

/**
 * `kodi update` — run the self-update now instead of waiting for the once-a-day
 * ambient check that rides along with every other subcommand. Explicit, so it
 * ignores both the daily cache and the `KODI_NO_AUTO_UPDATE`/CI opt-out; with
 * `--force` it reinstalls even when the published version is the one already
 * installed. Exits non-zero when the update was wanted but could not be done.
 */
export function registerUpdateCommand(program: Command, pkgName: string, currentVersion: string) {
  program
    .command('update')
    .description('Force the self-update now (ignores the daily check and KODI_NO_AUTO_UPDATE)')
    .option('--force', 'reinstall even when already on the latest published version', false)
    .action(async (o) => {
      const res = await forceUpdate(pkgName, currentVersion, { reinstall: Boolean(o.force) });

      if (!res.latest) {
        process.stderr.write(
          `kodi: could not reach the npm registry — check your connection and try again.\n`,
        );
        process.exitCode = 1;
        return;
      }
      if (res.alreadyLatest) {
        process.stdout.write(
          `kodi: already on the latest version (${currentVersion}). ` +
            `Pass --force to reinstall it anyway.\n`,
        );
        return;
      }
      if (res.updated) {
        process.stdout.write(
          `kodi: updated ${currentVersion} -> ${res.latest}. ` +
            `The new version runs starting next time you run kodi.\n`,
        );
        return;
      }
      process.stderr.write(
        `kodi: update to ${res.latest} failed — run \`npm install -g ${pkgName}@latest\` ` +
          `to update manually.\n`,
      );
      process.exitCode = 1;
    });
}
