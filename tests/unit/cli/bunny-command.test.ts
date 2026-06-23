import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveBunnyPaths } from '../../../src/bunny/config';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { formatRootConfig } from '../../../src/config/profile-store';
import { runBunnyStatus } from '../../../src/cli/commands/bunny';

const roots: string[] = [];

describe('Bunny CLI commands', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('uses root config activeProfile when config path is provided', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bunny-cli-'));
    roots.push(root);
    const configFile = join(root, 'config.json');
    await writeFile(configFile, formatRootConfig({
      schemaVersion: 2,
      activeProfile: 'codex-dev',
      preferences: {},
      profiles: {
        'codex-dev': createDefaultProfileConfig({
          agentKind: 'codex',
          accounts: {
            app: {
              id: 'cli_test',
              secret: '${APP_SECRET}',
              tenant: 'feishu',
            },
          },
          codex: { binaryPath: 'codex' },
        }),
      },
    }), { mode: 0o600 });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await runBunnyStatus({ config: configFile });

    const activeDb = resolveBunnyPaths(resolveAppPaths({ rootDir: root, profile: 'codex-dev' })).dbFile;
    const defaultDb = resolveBunnyPaths(resolveAppPaths({ rootDir: root })).dbFile;
    await expect(pathExists(activeDb)).resolves.toBe(true);
    await expect(pathExists(defaultDb)).resolves.toBe(false);
  });
});

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw err;
  }
}
