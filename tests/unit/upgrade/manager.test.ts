import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { UpgradeManager, runUpgradeCommand } from '../../../src/upgrade/manager';
import { resolveUpgradePaths } from '../../../src/upgrade/paths';
import { loadUpgradeState, saveUpgradeState, withUpgradeLock } from '../../../src/upgrade/state';

const roots: string[] = [];

describe('UpgradeManager', () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('reports disabled status without running git', async () => {
    const h = await harness();

    const result = await h.manager.status();

    expect(result.enabled).toBe(false);
    expect(h.run).not.toHaveBeenCalled();
  });

  it('checks configured release branch', async () => {
    const h = await harness({ enabled: true });
    h.run.mockResolvedValueOnce({ ok: true, stdout: '', stderr: '' });
    h.run.mockResolvedValueOnce({ ok: true, stdout: 'abc123\n', stderr: '' });
    h.run.mockResolvedValueOnce({
      ok: true,
      stdout: 'Update title\nAlice\n2026-06-20T00:00:00.000Z\n',
      stderr: '',
    });

    const result = await h.manager.check();

    expect(result.status).toBe('update');
    if (result.status !== 'update') throw new Error(`expected update, got ${result.status}`);
    expect(result.targetCommit).toBe('abc123');
    expect(result.title).toBe('Update title');
    expect(result.author).toBe('Alice');
    expect(h.run.mock.calls.map((call) => call[0])).toEqual(['git', 'git', 'git']);
    expect(h.run.mock.calls[0]?.[1]).toEqual([
      '-C',
      h.currentPath,
      'fetch',
      'origin',
      'refs/heads/release:refs/remotes/origin/release',
    ]);
  });

  it('checks from a git-backed previous release when the current runtime release has no git metadata', async () => {
    const h = await harness({ enabled: true, currentHasGit: false });
    const sourceRelease = join(h.root, 'profiles', 'claude', 'upgrades', 'releases', 'source-release');
    await mkdir(join(sourceRelease, '.git'), { recursive: true });
    await saveUpgradeState(h.paths.stateFile, {
      current: { commit: 'packaged', path: h.currentPath },
      previous: { commit: 'source', path: sourceRelease },
    });
    h.run.mockResolvedValueOnce({ ok: true, stdout: '', stderr: '' });
    h.run.mockResolvedValueOnce({ ok: true, stdout: 'abc123\n', stderr: '' });
    h.run.mockResolvedValueOnce({
      ok: true,
      stdout: 'Update title\nAlice\n2026-06-20T00:00:00.000Z\n',
      stderr: '',
    });

    const result = await h.manager.check();

    expect(result.status).toBe('update');
    expect(h.run.mock.calls[0]?.[1]).toEqual([
      '-C',
      sourceRelease,
      'fetch',
      'origin',
      'refs/heads/release:refs/remotes/origin/release',
    ]);
    expect(h.run.mock.calls[1]?.[1]).toEqual([
      '-C',
      sourceRelease,
      'rev-parse',
      'refs/remotes/origin/release',
    ]);
    expect(h.run.mock.calls[2]?.[1]?.slice(0, 2)).toEqual(['-C', sourceRelease]);
  });

  it('checks the configured source URL without requiring the current runtime path to be a git repository', async () => {
    const target = 'a'.repeat(40);
    const sourceUrl = 'https://github.com/example/lark-channel-bridge.git';
    const h = await harness({ enabled: true, currentHasGit: false, sourceUrl } as Parameters<typeof harness>[0]);
    h.run.mockResolvedValueOnce({ ok: true, stdout: `${target}\trefs/heads/release\n`, stderr: '' });

    const result = await h.manager.check();

    expect(result.status).toBe('update');
    if (result.status !== 'update') throw new Error(`expected update, got ${result.status}`);
    expect(result.targetCommit).toBe(target);
    expect(h.run).toHaveBeenCalledTimes(1);
    expect(h.run.mock.calls[0]?.[1]).toEqual(['ls-remote', sourceUrl, 'refs/heads/release']);
  });

  it('applies by cloning the configured source URL without requiring the current runtime path to be a git repository', async () => {
    const target = 'b'.repeat(40);
    const sourceUrl = 'https://github.com/example/lark-channel-bridge.git';
    const h = await harness({ enabled: true, currentHasGit: false, sourceUrl } as Parameters<typeof harness>[0]);
    await saveUpgradeState(h.paths.stateFile, {
      current: { commit: 'old', path: h.currentPath },
    });
    h.run
      .mockResolvedValueOnce({ ok: true, stdout: `${target}\trefs/heads/release\n`, stderr: '' })
      .mockResolvedValueOnce({ ok: true, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ ok: true, stdout: `${target}\n`, stderr: '' })
      .mockResolvedValue({ ok: true, stdout: '', stderr: '' });
    h.restart.mockResolvedValue({ ok: true, stderr: '' });

    const result = await h.manager.apply();

    expect(result.status).toBe('ok');
    expect(h.run.mock.calls[0]?.[1]).toEqual(['ls-remote', sourceUrl, 'refs/heads/release']);
    expect(h.run.mock.calls[1]?.[1]?.slice(0, 5)).toEqual([
      'clone',
      '--branch',
      'release',
      '--single-branch',
      sourceUrl,
    ]);
  });

  it('does not switch current when verification fails', async () => {
    const h = await harness({ enabled: true });
    await saveUpgradeState(h.paths.stateFile, {
      current: { commit: 'old', path: h.currentPath },
    });
    h.run.mockResolvedValueOnce({ ok: true, stdout: '', stderr: '' });
    h.run.mockResolvedValueOnce({ ok: true, stdout: 'new\n', stderr: '' });
    h.run.mockResolvedValueOnce({
      ok: true,
      stdout: 'https://github.com/doge-liang/lark-coding-agent-bridge.git\n',
      stderr: '',
    });
    h.run.mockResolvedValueOnce({ ok: true, stdout: '', stderr: '' });
    h.run.mockResolvedValueOnce({ ok: true, stdout: 'new\n', stderr: '' });
    h.run.mockResolvedValueOnce({ ok: true, stdout: '', stderr: '' });
    h.run.mockResolvedValueOnce({ ok: false, stdout: '', stderr: 'type error' });

    const result = await h.manager.apply();

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error(`expected failed, got ${result.status}`);
    expect(result.stage).toBe('typecheck');
    expect((await loadUpgradeState(h.paths.stateFile)).current?.commit).toBe('old');
    expect(h.restart).not.toHaveBeenCalled();
  });

  it('fails before switching when staged HEAD differs from target commit', async () => {
    const h = await harness({ enabled: true });
    await saveUpgradeState(h.paths.stateFile, {
      current: { commit: 'old', path: h.currentPath },
    });
    h.run
      .mockResolvedValueOnce({ ok: true, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ ok: true, stdout: 'new\n', stderr: '' })
      .mockResolvedValueOnce({
        ok: true,
        stdout: 'https://github.com/doge-liang/lark-coding-agent-bridge.git\n',
        stderr: '',
      })
      .mockResolvedValueOnce({ ok: true, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ ok: true, stdout: 'other\n', stderr: '' });

    const result = await h.manager.apply();

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error(`expected failed, got ${result.status}`);
    expect(result.stage).toBe('stage');
    expect((await loadUpgradeState(h.paths.stateFile)).current?.commit).toBe('old');
    expect(h.restart).not.toHaveBeenCalled();
  });

  it('writes pending activation and requests restart after verification passes', async () => {
    const notify = { chatId: 'oc_upgrade', messageId: 'om_upgrade' };
    const h = await harness({ enabled: true, activationNotify: notify });
    await saveUpgradeState(h.paths.stateFile, {
      current: { commit: 'old', path: h.currentPath },
    });
    h.run
      .mockResolvedValueOnce({ ok: true, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ ok: true, stdout: 'new\n', stderr: '' })
      .mockResolvedValueOnce({
        ok: true,
        stdout: 'https://github.com/doge-liang/lark-coding-agent-bridge.git\n',
        stderr: '',
      })
      .mockResolvedValueOnce({ ok: true, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ ok: true, stdout: 'new\n', stderr: '' })
      .mockResolvedValue({ ok: true, stdout: '', stderr: '' });
    h.restart.mockResolvedValue({ ok: true, stderr: '' });

    const result = await h.manager.apply();

    const state = await loadUpgradeState(h.paths.stateFile);
    expect(result.status).toBe('ok');
    expect(state.current?.commit).toBe('new');
    expect(state.previous?.commit).toBe('old');
    expect(state.pendingActivation?.commit).toBe('new');
    expect(state.pendingActivation?.notify).toEqual(notify);
    expect(h.restart).toHaveBeenCalledTimes(1);
  });

  it('refreshes the launcher before requesting restart after verification passes', async () => {
    const h = await harness({ enabled: true });
    await saveUpgradeState(h.paths.stateFile, {
      current: { commit: 'old', path: h.currentPath },
    });
    h.run
      .mockResolvedValueOnce({ ok: true, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ ok: true, stdout: 'new\n', stderr: '' })
      .mockResolvedValueOnce({
        ok: true,
        stdout: 'https://github.com/doge-liang/lark-coding-agent-bridge.git\n',
        stderr: '',
      })
      .mockResolvedValueOnce({ ok: true, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ ok: true, stdout: 'new\n', stderr: '' })
      .mockResolvedValue({ ok: true, stdout: '', stderr: '' });
    const order: string[] = [];
    h.refreshLauncher.mockImplementation(async () => {
      order.push('launcher');
    });
    h.restart.mockImplementation(async () => {
      order.push('restart');
      return { ok: true, stderr: '' };
    });

    const result = await h.manager.apply();

    expect(result.status).toBe('ok');
    expect(order).toEqual(['launcher', 'restart']);
  });

  it('releases the upgrade state lock before requesting restart', async () => {
    const h = await harness({ enabled: true });
    await saveUpgradeState(h.paths.stateFile, {
      current: { commit: 'old', path: h.currentPath },
    });
    h.run
      .mockResolvedValueOnce({ ok: true, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ ok: true, stdout: 'new\n', stderr: '' })
      .mockResolvedValueOnce({
        ok: true,
        stdout: 'https://github.com/doge-liang/lark-coding-agent-bridge.git\n',
        stderr: '',
      })
      .mockResolvedValueOnce({ ok: true, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ ok: true, stdout: 'new\n', stderr: '' })
      .mockResolvedValue({ ok: true, stdout: '', stderr: '' });
    let restartObservedUnlockedState = false;
    h.restart.mockImplementation(async () => {
      await withUpgradeLock(h.paths.lockFile, async () => {
        restartObservedUnlockedState = true;
      });
      return { ok: true, stderr: '' };
    });

    const result = await h.manager.apply();

    expect(result.status).toBe('ok');
    expect(restartObservedUnlockedState).toBe(true);
  });

  it('runs pnpm test during verification when required', async () => {
    const h = await harness({ enabled: true, requireTests: true });
    await saveUpgradeState(h.paths.stateFile, {
      current: { commit: 'old', path: h.currentPath },
    });
    h.run
      .mockResolvedValueOnce({ ok: true, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ ok: true, stdout: 'new\n', stderr: '' })
      .mockResolvedValueOnce({
        ok: true,
        stdout: 'https://github.com/doge-liang/lark-coding-agent-bridge.git\n',
        stderr: '',
      })
      .mockResolvedValueOnce({ ok: true, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ ok: true, stdout: 'new\n', stderr: '' })
      .mockResolvedValue({ ok: true, stdout: '', stderr: '' });
    h.restart.mockResolvedValue({ ok: true, stderr: '' });

    await h.manager.apply();

    expect(h.run.mock.calls.some((call) => call[0] === 'pnpm' && call[1]?.[0] === 'test')).toBe(true);
  });

  it('rolls back to previous and requests restart', async () => {
    const h = await harness({ enabled: true });
    await saveUpgradeState(h.paths.stateFile, {
      current: { commit: 'new', path: '/new' },
      previous: { commit: 'old', path: '/old' },
    });
    h.restart.mockResolvedValue({ ok: true, stderr: '' });

    const result = await h.manager.rollback();

    const state = await loadUpgradeState(h.paths.stateFile);
    expect(result.status).toBe('ok');
    expect(state.current?.commit).toBe('old');
    expect(state.previous).toBeUndefined();
    expect(state.lastOperation?.kind).toBe('rollback');
    expect(h.restart).toHaveBeenCalledTimes(1);
  });
});

describe('runUpgradeCommand', () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('appends command output and errors to the provided log path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'upgrade-manager-runner-'));
    roots.push(root);
    const logPath = join(root, 'upgrade.log');

    const result = await runUpgradeCommand(
      process.execPath,
      ['-e', "process.stdout.write('out'); process.stderr.write('err');"],
      { logPath },
    );

    expect(result).toEqual({ ok: true, stdout: 'out', stderr: 'err' });
    await expect(readFile(logPath, 'utf8')).resolves.toContain('$ ');
    await expect(readFile(logPath, 'utf8')).resolves.toContain('out');
    await expect(readFile(logPath, 'utf8')).resolves.toContain('err');
  });
});

async function harness(
  overrides: Partial<ReturnType<typeof createDefaultProfileConfig>['upgrade']> & {
    activationNotify?: { chatId: string; messageId?: string };
    currentHasGit?: boolean;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'upgrade-manager-'));
  roots.push(root);
  const currentPath = join(root, 'current');
  const appPaths = {
    profile: 'claude',
    profileDir: join(root, 'profiles', 'claude'),
  };
  const profileConfig = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
  });
  const { activationNotify, currentHasGit = true, ...upgradeOverrides } = overrides;
  if (currentHasGit) await mkdir(join(currentPath, '.git'), { recursive: true });
  profileConfig.upgrade = { ...profileConfig.upgrade, ...upgradeOverrides };
  const paths = resolveUpgradePaths(appPaths);
  const run = vi.fn();
  const restart = vi.fn();
  const refreshLauncher = vi.fn();
  const manager = new UpgradeManager({
    appPaths,
    profileConfig,
    currentPath,
    runCommand: run,
    restartService: restart,
    refreshLauncher,
    now: () => new Date('2026-06-20T00:00:00.000Z'),
    operationId: () => 'op-1',
    ...(activationNotify ? { activationNotify } : {}),
  });
  return { root, appPaths, profileConfig, paths, currentPath, run, restart, refreshLauncher, manager };
}
