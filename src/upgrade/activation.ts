import type { AppPaths } from '../config/app-paths';
import { resolveUpgradePaths } from './paths';
import {
  clearPendingActivation,
  loadUpgradeState,
  saveUpgradeState,
  withUpgradeLock,
} from './state';

export async function markUpgradeActivationHealthy(
  appPaths: Pick<AppPaths, 'profileDir'>,
  commit: string | undefined,
  now = new Date(),
): Promise<void> {
  if (!commit) return;
  const upgradePaths = resolveUpgradePaths(appPaths);
  await withUpgradeLock(upgradePaths.lockFile, async () => {
    const state = await loadUpgradeState(upgradePaths.stateFile);
    if (!state.pendingActivation || state.pendingActivation.commit !== commit) return;
    await saveUpgradeState(upgradePaths.stateFile, clearPendingActivation(state, now));
  });
}
