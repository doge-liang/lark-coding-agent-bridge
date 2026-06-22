import type { AppPaths } from '../config/app-paths';
import { resolveUpgradePaths } from './paths';
import {
  clearPendingActivation,
  loadUpgradeState,
  saveUpgradeState,
  withUpgradeLock,
  type UpgradeActivationNotify,
  type UpgradeLockOptions,
  type UpgradePendingNotification,
} from './state';

export interface UpgradeActivationHealthyResult {
  commit: string;
  notify?: UpgradeActivationNotify;
}

export type UpgradeNotificationResult = UpgradePendingNotification;

export interface UpgradeActivationHealthyOptions {
  lock?: UpgradeLockOptions;
}

const DEFAULT_ACTIVATION_LOCK_OPTIONS: UpgradeLockOptions = {
  retries: { retries: 60, minTimeout: 500, maxTimeout: 1_000 },
};

export async function markUpgradeActivationHealthy(
  appPaths: Pick<AppPaths, 'profileDir'>,
  commit: string | undefined,
  now = new Date(),
  options: UpgradeActivationHealthyOptions = {},
): Promise<UpgradeActivationHealthyResult | undefined> {
  if (!commit) return undefined;
  const upgradePaths = resolveUpgradePaths(appPaths);
  return withUpgradeLock(upgradePaths.lockFile, async () => {
    const state = await loadUpgradeState(upgradePaths.stateFile);
    if (!state.pendingActivation || state.pendingActivation.commit !== commit) return undefined;
    const result: UpgradeActivationHealthyResult = {
      commit: state.pendingActivation.commit,
      ...(state.pendingActivation.notify ? { notify: state.pendingActivation.notify } : {}),
    };
    await saveUpgradeState(upgradePaths.stateFile, clearPendingActivation(state, now));
    return result;
  }, options.lock ?? DEFAULT_ACTIVATION_LOCK_OPTIONS);
}

export async function readPendingUpgradeNotification(
  appPaths: Pick<AppPaths, 'profileDir'>,
): Promise<UpgradeNotificationResult | undefined> {
  const upgradePaths = resolveUpgradePaths(appPaths);
  return withUpgradeLock(upgradePaths.lockFile, async () => {
    const state = await loadUpgradeState(upgradePaths.stateFile);
    return state.pendingNotification;
  });
}

export async function clearPendingUpgradeNotification(
  appPaths: Pick<AppPaths, 'profileDir'>,
  id: string,
): Promise<void> {
  const upgradePaths = resolveUpgradePaths(appPaths);
  await withUpgradeLock(upgradePaths.lockFile, async () => {
    const state = await loadUpgradeState(upgradePaths.stateFile);
    if (state.pendingNotification?.id !== id) return;
    const { pendingNotification: _pendingNotification, ...next } = state;
    await saveUpgradeState(upgradePaths.stateFile, next);
  });
}
