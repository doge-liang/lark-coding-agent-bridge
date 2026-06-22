import type { AppPaths } from '../config/app-paths';
import { resolveUpgradePaths } from './paths';
import {
  clearPendingActivation,
  loadUpgradeState,
  saveUpgradeState,
  withUpgradeLock,
  type UpgradeActivationNotify,
} from './state';

export interface UpgradeActivationHealthyResult {
  commit: string;
  notify?: UpgradeActivationNotify;
}

export async function markUpgradeActivationHealthy(
  appPaths: Pick<AppPaths, 'profileDir'>,
  commit: string | undefined,
  now = new Date(),
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
  });
}
