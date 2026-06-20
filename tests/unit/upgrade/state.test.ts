import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearPendingActivation,
  loadUpgradeState,
  markActivationRolledBack,
  saveUpgradeState,
  setPendingActivation,
  withUpgradeLock,
} from '../../../src/upgrade/state';

const roots: string[] = [];

describe('upgrade state store', () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('loads empty state for a missing file', async () => {
    const root = await tempRoot();
    await expect(loadUpgradeState(join(root, 'state.json'))).resolves.toEqual({});
  });

  it('saves and reloads state atomically', async () => {
    const root = await tempRoot();
    const stateFile = join(root, 'state.json');
    await saveUpgradeState(stateFile, {
      current: { commit: 'abc123', path: '/releases/abc123', activatedAt: '2026-06-20T00:00:00.000Z' },
    });

    await expect(loadUpgradeState(stateFile)).resolves.toEqual({
      current: { commit: 'abc123', path: '/releases/abc123', activatedAt: '2026-06-20T00:00:00.000Z' },
    });
  });

  it('sets and clears pending activation', () => {
    const next = setPendingActivation(
      { current: { commit: 'old', path: '/old' } },
      {
        commit: 'new',
        path: '/new',
        previousCommit: 'old',
        previousPath: '/old',
        now: new Date('2026-06-20T00:00:00.000Z'),
        healthTimeoutMs: 60_000,
        operationId: 'op-1',
      },
    );

    expect(next.current).toEqual({ commit: 'new', path: '/new' });
    expect(next.previous).toEqual({ commit: 'old', path: '/old' });
    expect(next.pendingActivation).toEqual({
      commit: 'new',
      operationId: 'op-1',
      startedAt: '2026-06-20T00:00:00.000Z',
      deadlineAt: '2026-06-20T00:01:00.000Z',
    });

    const cleared = clearPendingActivation(next, new Date('2026-06-20T00:00:30.000Z'));
    expect(cleared.pendingActivation).toBeUndefined();
    expect(cleared.current).toEqual({
      commit: 'new',
      path: '/new',
      activatedAt: '2026-06-20T00:00:30.000Z',
    });
    expect(cleared.lastOperation).toMatchObject({
      kind: 'apply',
      status: 'ok',
      stage: 'activation',
      message: 'activation healthy',
    });
  });

  it('rolls back current to previous and records last operation', () => {
    const rolledBack = markActivationRolledBack(
      {
        current: { commit: 'new', path: '/new' },
        previous: { commit: 'old', path: '/old' },
        pendingActivation: {
          commit: 'new',
          operationId: 'op-1',
          startedAt: '2026-06-20T00:00:00.000Z',
          deadlineAt: '2026-06-20T00:01:00.000Z',
        },
      },
      'health-timeout',
    );

    expect(rolledBack.current).toEqual({ commit: 'old', path: '/old' });
    expect(rolledBack.pendingActivation).toBeUndefined();
    expect(rolledBack.lastOperation).toMatchObject({
      kind: 'apply',
      status: 'rolled_back',
      stage: 'activation',
      message: 'health-timeout',
    });
  });

  it('serializes access through the lock file', async () => {
    const root = await tempRoot();
    const lockFile = join(root, 'state.lock');
    const order: string[] = [];
    let releaseFirst!: () => void;
    let firstEntered!: () => void;
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstEntry = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });

    const first = withUpgradeLock(lockFile, async () => {
      order.push('first-enter');
      firstEntered();
      await firstRelease;
      order.push('first-exit');
    });

    await firstEntry;
    let secondEntered = false;
    const second = withUpgradeLock(lockFile, async () => {
      secondEntered = true;
      order.push('second-enter');
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(secondEntered).toBe(false);
    releaseFirst();
    await Promise.all([first, second]);

    expect(order).toEqual(['first-enter', 'first-exit', 'second-enter']);
  });

  it('drops malformed optional fields when loading state', async () => {
    const root = await tempRoot();
    const stateFile = join(root, 'state.json');
    await writeFile(
      stateFile,
      JSON.stringify({
        current: { commit: 'abc123', path: '/releases/abc123', activatedAt: 123 },
        lastOperation: {
          kind: 'apply',
          status: 'ok',
          stage: 'activation',
          message: 'activation healthy',
          logPath: 123,
          at: '2026-06-20T00:00:30.000Z',
        },
      }),
    );

    await expect(loadUpgradeState(stateFile)).resolves.toEqual({
      current: { commit: 'abc123', path: '/releases/abc123' },
      lastOperation: {
        kind: 'apply',
        status: 'ok',
        stage: 'activation',
        message: 'activation healthy',
        at: '2026-06-20T00:00:30.000Z',
      },
    });
  });
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'upgrade-state-'));
  roots.push(root);
  return root;
}
