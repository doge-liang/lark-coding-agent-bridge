import { describe, expect, it } from 'vitest';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { resolveUpgradePaths } from '../../../src/upgrade/paths';

describe('upgrade paths', () => {
  it('derives profile-local update paths', () => {
    const appPaths = resolveAppPaths({ rootDir: '/tmp/lark-home', profile: 'codex-dev' });
    const paths = resolveUpgradePaths(appPaths);

    expect(paths.rootDir).toBe('/tmp/lark-home/profiles/codex-dev/upgrades');
    expect(paths.launcherFile).toBe('/tmp/lark-home/profiles/codex-dev/upgrades/launcher.mjs');
    expect(paths.stateFile).toBe('/tmp/lark-home/profiles/codex-dev/upgrades/state.json');
    expect(paths.lockFile).toBe('/tmp/lark-home/profiles/codex-dev/upgrades/state.lock');
    expect(paths.releaseDir('abc123')).toBe('/tmp/lark-home/profiles/codex-dev/upgrades/releases/abc123');
    expect(paths.stagingDir('op-1')).toBe('/tmp/lark-home/profiles/codex-dev/upgrades/staging/op-1');
    expect(paths.logFile('op-1')).toBe('/tmp/lark-home/profiles/codex-dev/upgrades/logs/op-1.log');
  });
});
