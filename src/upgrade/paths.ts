import { join } from 'node:path';
import type { AppPaths } from '../config/app-paths';

export interface UpgradePaths {
  rootDir: string;
  launcherFile: string;
  stateFile: string;
  lockFile: string;
  releasesDir: string;
  stagingRootDir: string;
  logsDir: string;
  releaseDir(commit: string): string;
  stagingDir(operationId: string): string;
  logFile(operationId: string): string;
}

export function resolveUpgradePaths(appPaths: Pick<AppPaths, 'profileDir'>): UpgradePaths {
  const rootDir = join(appPaths.profileDir, 'upgrades');
  const releasesDir = join(rootDir, 'releases');
  const stagingRootDir = join(rootDir, 'staging');
  const logsDir = join(rootDir, 'logs');
  return {
    rootDir,
    launcherFile: join(rootDir, 'launcher.mjs'),
    stateFile: join(rootDir, 'state.json'),
    lockFile: join(rootDir, 'state.lock'),
    releasesDir,
    stagingRootDir,
    logsDir,
    releaseDir: (commit) => join(releasesDir, safePathSegment(commit)),
    stagingDir: (operationId) => join(stagingRootDir, safePathSegment(operationId)),
    logFile: (operationId) => join(logsDir, `${safePathSegment(operationId)}.log`),
  };
}

function safePathSegment(value: string): string {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed) || trimmed === '.' || trimmed === '..') {
    throw new Error(`invalid upgrade path segment: ${value}`);
  }
  return trimmed;
}
