import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { markUpgradeActivationHealthy } from '../../../src/upgrade/activation';
import { resolveUpgradePaths } from '../../../src/upgrade/paths';
import { loadUpgradeState, saveUpgradeState } from '../../../src/upgrade/state';

const roots: string[] = [];

describe('upgrade activation health', () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('clears pending activation when the current commit becomes healthy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'upgrade-activation-'));
    roots.push(root);
    const appPaths = resolveAppPaths({ rootDir: root, profile: 'claude' });
    const upgradePaths = resolveUpgradePaths(appPaths);
    await saveUpgradeState(upgradePaths.stateFile, {
      current: { commit: 'abc123', path: '/releases/abc123' },
      pendingActivation: {
        commit: 'abc123',
        operationId: 'op-1',
        startedAt: '2026-06-20T00:00:00.000Z',
        deadlineAt: '2026-06-20T00:01:00.000Z',
      },
    });

    await markUpgradeActivationHealthy(appPaths, 'abc123', new Date('2026-06-20T00:00:30.000Z'));

    const state = await loadUpgradeState(upgradePaths.stateFile);
    expect(state.pendingActivation).toBeUndefined();
    expect(state.current?.activatedAt).toBe('2026-06-20T00:00:30.000Z');
    expect(state.lastOperation?.status).toBe('ok');
  });

  it('returns the activation notification target once when the current commit becomes healthy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'upgrade-activation-'));
    roots.push(root);
    const appPaths = resolveAppPaths({ rootDir: root, profile: 'claude' });
    const upgradePaths = resolveUpgradePaths(appPaths);
    await saveUpgradeState(upgradePaths.stateFile, {
      current: { commit: 'abc123', path: '/releases/abc123' },
      pendingActivation: {
        commit: 'abc123',
        operationId: 'op-1',
        startedAt: '2026-06-20T00:00:00.000Z',
        deadlineAt: '2026-06-20T00:01:00.000Z',
        notify: { chatId: 'oc_upgrade', messageId: 'om_upgrade' },
      },
    });

    const result = await markUpgradeActivationHealthy(
      appPaths,
      'abc123',
      new Date('2026-06-20T00:00:30.000Z'),
    );

    expect(result).toEqual({
      commit: 'abc123',
      notify: { chatId: 'oc_upgrade', messageId: 'om_upgrade' },
    });
    await expect(markUpgradeActivationHealthy(appPaths, 'abc123')).resolves.toBeUndefined();
  });

  it('does nothing when there is no matching pending activation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'upgrade-activation-'));
    roots.push(root);
    const appPaths = resolveAppPaths({ rootDir: root, profile: 'claude' });
    const upgradePaths = resolveUpgradePaths(appPaths);
    await saveUpgradeState(upgradePaths.stateFile, {
      current: { commit: 'abc123', path: '/releases/abc123' },
      pendingActivation: {
        commit: 'other',
        operationId: 'op-1',
        startedAt: '2026-06-20T00:00:00.000Z',
        deadlineAt: '2026-06-20T00:01:00.000Z',
      },
    });

    await markUpgradeActivationHealthy(appPaths, 'abc123');

    const state = await loadUpgradeState(upgradePaths.stateFile);
    expect(state.pendingActivation?.commit).toBe('other');
  });
});
