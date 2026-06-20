import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import * as lockfile from 'proper-lockfile';
import { writeFileAtomic } from '../platform/atomic-write';

export interface UpgradeReleaseRef {
  commit: string;
  path: string;
  activatedAt?: string;
}

export interface PendingActivation {
  commit: string;
  operationId: string;
  startedAt: string;
  deadlineAt: string;
}

export interface UpgradeLastOperation {
  kind: 'check' | 'apply' | 'rollback';
  status: 'ok' | 'failed' | 'rolled_back';
  stage: string;
  message: string;
  logPath?: string;
  at: string;
}

export interface UpgradeState {
  current?: UpgradeReleaseRef;
  previous?: UpgradeReleaseRef;
  pendingActivation?: PendingActivation;
  lastOperation?: UpgradeLastOperation;
}

export async function loadUpgradeState(stateFile: string): Promise<UpgradeState> {
  try {
    const parsed = JSON.parse(await readFile(stateFile, 'utf8')) as unknown;
    return normalizeUpgradeState(parsed);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}

export async function saveUpgradeState(stateFile: string, state: UpgradeState): Promise<void> {
  await writeFileAtomic(stateFile, `${JSON.stringify(serializeUpgradeState(state), null, 2)}\n`, {
    mode: 0o600,
  });
}

export async function withUpgradeLock<T>(lockFile: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(dirname(lockFile), { recursive: true });
  await writeFile(lockFile, '', { flag: 'a', mode: 0o600 });
  await chmod(lockFile, 0o600).catch(() => {});
  const release = await lockfile.lock(lockFile, {
    realpath: false,
    stale: 30_000,
    update: 10_000,
    retries: { retries: 10, minTimeout: 10, maxTimeout: 100 },
  });
  try {
    return await fn();
  } finally {
    await release();
  }
}

export function setPendingActivation(
  state: UpgradeState,
  input: {
    commit: string;
    path: string;
    previousCommit?: string;
    previousPath?: string;
    now: Date;
    healthTimeoutMs: number;
    operationId: string;
  },
): UpgradeState {
  const startedAt = input.now.toISOString();
  const deadlineAt = new Date(input.now.getTime() + input.healthTimeoutMs).toISOString();
  return {
    ...state,
    current: { commit: input.commit, path: input.path },
    ...(input.previousCommit && input.previousPath
      ? { previous: { commit: input.previousCommit, path: input.previousPath } }
      : {}),
    pendingActivation: {
      commit: input.commit,
      operationId: input.operationId,
      startedAt,
      deadlineAt,
    },
  };
}

export function clearPendingActivation(state: UpgradeState, now = new Date()): UpgradeState {
  const { pendingActivation: _pendingActivation, ...rest } = state;
  return {
    ...rest,
    current: rest.current ? { ...rest.current, activatedAt: now.toISOString() } : rest.current,
    lastOperation: {
      kind: 'apply',
      status: 'ok',
      stage: 'activation',
      message: 'activation healthy',
      at: now.toISOString(),
    },
  };
}

export function markActivationRolledBack(
  state: UpgradeState,
  message: string,
  now = new Date(),
): UpgradeState {
  if (!state.previous) {
    const { pendingActivation: _pendingActivation, ...rest } = state;
    return {
      ...rest,
      lastOperation: {
        kind: 'apply',
        status: 'failed',
        stage: 'activation',
        message,
        at: now.toISOString(),
      },
    };
  }
  return {
    current: state.previous,
    previous: state.current,
    lastOperation: {
      kind: 'apply',
      status: 'rolled_back',
      stage: 'activation',
      message,
      at: now.toISOString(),
    },
  };
}

function normalizeUpgradeState(input: unknown): UpgradeState {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const raw = input as Partial<UpgradeState>;
  return serializeUpgradeState(raw);
}

function serializeUpgradeState(state: UpgradeState): UpgradeState {
  return {
    ...(isReleaseRef(state.current) ? { current: serializeReleaseRef(state.current) } : {}),
    ...(isReleaseRef(state.previous) ? { previous: serializeReleaseRef(state.previous) } : {}),
    ...(isPendingActivation(state.pendingActivation) ? { pendingActivation: state.pendingActivation } : {}),
    ...(isLastOperation(state.lastOperation) ? { lastOperation: serializeLastOperation(state.lastOperation) } : {}),
  };
}

function serializeReleaseRef(value: UpgradeReleaseRef): UpgradeReleaseRef {
  return {
    commit: value.commit,
    path: value.path,
    ...(typeof value.activatedAt === 'string' ? { activatedAt: value.activatedAt } : {}),
  };
}

function serializeLastOperation(value: UpgradeLastOperation): UpgradeLastOperation {
  return {
    kind: value.kind,
    status: value.status,
    stage: value.stage,
    message: value.message,
    ...(typeof value.logPath === 'string' ? { logPath: value.logPath } : {}),
    at: value.at,
  };
}

function isReleaseRef(value: unknown): value is UpgradeReleaseRef {
  if (!value || typeof value !== 'object') return false;
  const raw = value as Partial<UpgradeReleaseRef>;
  return typeof raw.commit === 'string' && typeof raw.path === 'string';
}

function isPendingActivation(value: unknown): value is PendingActivation {
  if (!value || typeof value !== 'object') return false;
  const raw = value as Partial<PendingActivation>;
  return (
    typeof raw.commit === 'string' &&
    typeof raw.operationId === 'string' &&
    typeof raw.startedAt === 'string' &&
    typeof raw.deadlineAt === 'string'
  );
}

function isLastOperation(value: unknown): value is UpgradeLastOperation {
  if (!value || typeof value !== 'object') return false;
  const raw = value as Partial<UpgradeLastOperation>;
  return (
    (raw.kind === 'check' || raw.kind === 'apply' || raw.kind === 'rollback') &&
    (raw.status === 'ok' || raw.status === 'failed' || raw.status === 'rolled_back') &&
    typeof raw.stage === 'string' &&
    typeof raw.message === 'string' &&
    typeof raw.at === 'string'
  );
}
