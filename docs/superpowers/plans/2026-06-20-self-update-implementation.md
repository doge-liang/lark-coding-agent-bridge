# Controlled Self-Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `/upgrade status|check|apply|rollback` with trusted `origin/release` staging, profile-local launcher activation, and automatic rollback.

**Architecture:** Add a focused `src/upgrade/` subsystem for config paths, state, launcher generation, activation health, and git/pnpm orchestration. Wire it into existing profile config, daemon service definitions, `runStart()` health timing, and the Lark command handler. Keep all update authority in bridge-owned code, with no agent shell delegation.

**Tech Stack:** TypeScript ESM, Node.js `fs/promises`, `child_process` through existing spawn helpers, `proper-lockfile`, Vitest, existing launchd/systemd/schtasks service adapters.

---

## Scope Check

The approved spec is one cohesive subsystem: controlled self-update for one bridge profile. It touches config, service launch, runtime activation, command handling, and tests, but each part is required for one working feature. Do not split this into separate feature plans.

## File Structure

- Create `src/upgrade/paths.ts`: derive profile-local upgrade paths from `AppPaths`.
- Create `src/upgrade/state.ts`: load/save state, lock state changes, transition pending/healthy/rolled-back states.
- Create `src/upgrade/launcher-script.ts`: generate the standalone profile-local `launcher.mjs` and expose pure helpers for tests.
- Create `src/upgrade/activation.ts`: no-op-safe health marker called after `startChannel()` succeeds.
- Create `src/upgrade/manager.ts`: check/apply/rollback orchestration with injectable command runner and service restarter.
- Create `src/upgrade/command-service.ts`: small adapter that turns manager results into user-facing markdown.
- Modify `src/config/profile-schema.ts`: add normalized `upgrade` profile config.
- Modify `src/config/profile-store.ts`: serialize `upgrade` config.
- Modify `src/daemon/launchd.ts`, `src/daemon/systemd.ts`, `src/daemon/schtasks.ts`: install launcher and point service definitions to it.
- Modify `src/cli/commands/start.ts`: mark pending activation healthy after bot identity is available.
- Modify `src/commands/index.ts`: register `/upgrade` and enforce p2p owner/admin access.
- Modify `README.md` and `README.zh.md`: document `/upgrade` commands and safety model.
- Add focused tests under `tests/unit/upgrade/`, plus targeted daemon/config/command tests.

---

### Task 1: Upgrade Config And Paths

**Files:**
- Create: `src/upgrade/paths.ts`
- Modify: `src/config/profile-schema.ts`
- Modify: `src/config/profile-store.ts`
- Test: `tests/unit/config/profile-schema.test.ts`
- Test: `tests/unit/upgrade/paths.test.ts`

- [ ] **Step 1: Write failing config tests**

Add these tests to `tests/unit/config/profile-schema.test.ts`:

```ts
it('defaults controlled self-update to release branch with fast verification', () => {
  const cfg = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app },
  });

  expect(cfg.upgrade).toEqual({
    enabled: false,
    remote: 'origin',
    branch: 'release',
    requireTests: false,
    healthTimeoutMs: 60_000,
    retainReleases: 3,
  });
});

it('normalizes upgrade config with safe fallbacks', () => {
  const cfg = normalizeProfileConfig({
    schemaVersion: 2,
    agentKind: 'claude',
    accounts: { app },
    upgrade: {
      enabled: true,
      remote: 'upstream',
      branch: 'stable',
      requireTests: true,
      healthTimeoutMs: 120_000,
      retainReleases: 5,
    },
  });

  expect(cfg.upgrade).toEqual({
    enabled: true,
    remote: 'upstream',
    branch: 'stable',
    requireTests: true,
    healthTimeoutMs: 120_000,
    retainReleases: 5,
  });
});

it('serializes upgrade config into root config files', async () => {
  const cfg = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app },
  });
  cfg.upgrade = {
    enabled: true,
    remote: 'origin',
    branch: 'release',
    requireTests: true,
    healthTimeoutMs: 90_000,
    retainReleases: 4,
  };

  const text = formatRootConfig(createRootConfig('claude', cfg));

  expect(JSON.parse(text).profiles.claude.upgrade).toEqual(cfg.upgrade);
});
```

- [ ] **Step 2: Write failing path tests**

Create `tests/unit/upgrade/paths.test.ts`:

```ts
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
pnpm test tests/unit/config/profile-schema.test.ts tests/unit/upgrade/paths.test.ts
```

Expected: FAIL because `upgrade` config and `resolveUpgradePaths` do not exist.

- [ ] **Step 4: Implement config normalization**

Modify `src/config/profile-schema.ts` with these additions:

```ts
export interface UpgradeConfig {
  enabled: boolean;
  remote: string;
  branch: string;
  requireTests: boolean;
  healthTimeoutMs: number;
  retainReleases: number;
}
```

Add `upgrade: UpgradeConfig;` to `ProfileConfig`.

Add `upgrade?: unknown;` to the `raw` object in `normalizeProfileConfig()`.

Before the return in `normalizeProfileConfig()`:

```ts
const upgrade = normalizeUpgrade(raw.upgrade);
```

Add `upgrade,` to the returned profile object.

Add this helper near the other normalizers:

```ts
function normalizeUpgrade(input: unknown): UpgradeConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return defaultUpgradeConfig();
  }
  const raw = input as Record<string, unknown>;
  const remote = nonEmptyString(raw.remote, 'origin');
  const branch = nonEmptyString(raw.branch, 'release');
  return {
    enabled: raw.enabled === true,
    remote,
    branch,
    requireTests: raw.requireTests === true,
    healthTimeoutMs: positiveInt(raw.healthTimeoutMs, 60_000),
    retainReleases: positiveInt(raw.retainReleases, 3),
  };
}

function defaultUpgradeConfig(): UpgradeConfig {
  return {
    enabled: false,
    remote: 'origin',
    branch: 'release',
    requireTests: false,
    healthTimeoutMs: 60_000,
    retainReleases: 3,
  };
}

function nonEmptyString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}
```

- [ ] **Step 5: Serialize config**

Modify `src/config/profile-store.ts`:

```ts
type StoredProfileConfig = Pick<
  ProfileConfig,
  | 'schemaVersion'
  | 'agentKind'
  | 'accounts'
  | 'secrets'
  | 'preferences'
  | 'access'
  | 'workspaces'
  | 'permissions'
  | 'codex'
  | 'attachments'
  | 'comments'
  | 'larkCli'
  | 'upgrade'
>;
```

Add to `serializeProfileConfig()`:

```ts
upgrade: profile.upgrade,
```

- [ ] **Step 6: Add upgrade paths module**

Create `src/upgrade/paths.ts`:

```ts
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
```

- [ ] **Step 7: Run task tests**

Run:

```bash
pnpm test tests/unit/config/profile-schema.test.ts tests/unit/upgrade/paths.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/config/profile-schema.ts src/config/profile-store.ts src/upgrade/paths.ts tests/unit/config/profile-schema.test.ts tests/unit/upgrade/paths.test.ts
git commit -m "feat: add upgrade config and paths"
```

---

### Task 2: Upgrade State Store

**Files:**
- Create: `src/upgrade/state.ts`
- Test: `tests/unit/upgrade/state.test.ts`

- [ ] **Step 1: Write failing state tests**

Create `tests/unit/upgrade/state.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
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

    expect(clearPendingActivation(next, new Date('2026-06-20T00:00:30.000Z')).pendingActivation).toBeUndefined();
  });

  it('rolls back current to previous and records last operation', () => {
    const rolledBack = markActivationRolledBack({
      current: { commit: 'new', path: '/new' },
      previous: { commit: 'old', path: '/old' },
      pendingActivation: {
        commit: 'new',
        operationId: 'op-1',
        startedAt: '2026-06-20T00:00:00.000Z',
        deadlineAt: '2026-06-20T00:01:00.000Z',
      },
    }, 'health-timeout');

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

    await withUpgradeLock(lockFile, async () => {
      order.push('first');
    });
    await withUpgradeLock(lockFile, async () => {
      order.push('second');
    });

    expect(order).toEqual(['first', 'second']);
  });
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'upgrade-state-'));
  roots.push(root);
  return root;
}
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm test tests/unit/upgrade/state.test.ts
```

Expected: FAIL because `src/upgrade/state.ts` does not exist.

- [ ] **Step 3: Implement state store**

Create `src/upgrade/state.ts`:

```ts
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

export function markActivationRolledBack(state: UpgradeState, message: string, now = new Date()): UpgradeState {
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
    ...(isReleaseRef(state.current) ? { current: state.current } : {}),
    ...(isReleaseRef(state.previous) ? { previous: state.previous } : {}),
    ...(isPendingActivation(state.pendingActivation) ? { pendingActivation: state.pendingActivation } : {}),
    ...(isLastOperation(state.lastOperation) ? { lastOperation: state.lastOperation } : {}),
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
```

- [ ] **Step 4: Run task tests**

Run:

```bash
pnpm test tests/unit/upgrade/state.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/upgrade/state.ts tests/unit/upgrade/state.test.ts
git commit -m "feat: add upgrade state store"
```

---

### Task 3: Launcher Script And Service Definitions

**Files:**
- Create: `src/upgrade/launcher-script.ts`
- Modify: `src/daemon/launchd.ts`
- Modify: `src/daemon/systemd.ts`
- Modify: `src/daemon/schtasks.ts`
- Test: `tests/unit/upgrade/launcher-script.test.ts`
- Test: `tests/unit/daemon/profile-args.test.ts`

- [ ] **Step 1: Write failing launcher script test**

Create `tests/unit/upgrade/launcher-script.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildUpgradeLauncherScript } from '../../../src/upgrade/launcher-script';

describe('upgrade launcher script', () => {
  it('embeds profile, home, fallback entry, and health timeout', () => {
    const script = buildUpgradeLauncherScript({
      profile: 'codex-dev',
      channelHome: '/tmp/lark-home',
      fallbackNodePath: '/usr/bin/node',
      fallbackBridgeEntryPath: '/repo/bin/lark-channel-bridge.mjs',
    });

    expect(script).toContain('const PROFILE = "codex-dev";');
    expect(script).toContain('const CHANNEL_HOME = "/tmp/lark-home";');
    expect(script).toContain('const FALLBACK_NODE = "/usr/bin/node";');
    expect(script).toContain('const FALLBACK_BRIDGE_ENTRY = "/repo/bin/lark-channel-bridge.mjs";');
    expect(script).toContain('pendingActivation');
    expect(script).toContain('rollbackState');
  });
});
```

- [ ] **Step 2: Update failing daemon argument test**

Modify the second test in `tests/unit/daemon/profile-args.test.ts`:

```ts
it('pins launchd, systemd, and schtasks launch commands to the upgrade launcher', () => {
  const inputs = {
    nodePath: '/usr/local/bin/node',
    bridgeEntryPath: '/repo/bin/lark-channel-bridge.mjs',
    upgradeLauncherPath: '/tmp/lark-channel-home/profiles/codex-dev/upgrades/launcher.mjs',
    envPath: '/usr/local/bin:/usr/bin',
    profile: 'codex-dev',
    channelHome: '/tmp/lark-channel-home',
  };

  expect(buildPlist(inputs)).toContain('<string>/tmp/lark-channel-home/profiles/codex-dev/upgrades/launcher.mjs</string>');
  expect(buildPlist(inputs)).toContain('<string>--profile</string>\n        <string>codex-dev</string>');
  expect(buildPlist(inputs)).toContain('<key>LARK_CHANNEL_HOME</key>\n        <string>/tmp/lark-channel-home</string>');
  expect(buildUnit(inputs)).toContain('"/usr/local/bin/node" "/tmp/lark-channel-home/profiles/codex-dev/upgrades/launcher.mjs" --profile "codex-dev"');
  expect(buildUnit(inputs)).toContain('Environment="LARK_CHANNEL_HOME=/tmp/lark-channel-home"');
  expect(buildLauncherCmd(inputs)).toContain('"/usr/local/bin/node" "/tmp/lark-channel-home/profiles/codex-dev/upgrades/launcher.mjs" --profile "codex-dev"');
  expect(buildLauncherCmd(inputs)).toContain('set "LARK_CHANNEL_HOME=/tmp/lark-channel-home"');
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
pnpm test tests/unit/upgrade/launcher-script.test.ts tests/unit/daemon/profile-args.test.ts
```

Expected: FAIL because the launcher script builder and daemon input fields are missing.

- [ ] **Step 4: Implement launcher script builder**

Create `src/upgrade/launcher-script.ts`:

```ts
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { writeFileAtomic } from '../platform/atomic-write';

export interface UpgradeLauncherScriptInputs {
  profile: string;
  channelHome: string;
  fallbackNodePath: string;
  fallbackBridgeEntryPath: string;
}

export async function writeUpgradeLauncherScript(
  launcherFile: string,
  inputs: UpgradeLauncherScriptInputs,
): Promise<void> {
  await mkdir(dirname(launcherFile), { recursive: true });
  await writeFileAtomic(launcherFile, buildUpgradeLauncherScript(inputs), { mode: 0o700 });
}

export function buildUpgradeLauncherScript(inputs: UpgradeLauncherScriptInputs): string {
  return `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const PROFILE = ${JSON.stringify(inputs.profile)};
const CHANNEL_HOME = ${JSON.stringify(inputs.channelHome)};
const FALLBACK_NODE = ${JSON.stringify(inputs.fallbackNodePath)};
const FALLBACK_BRIDGE_ENTRY = ${JSON.stringify(inputs.fallbackBridgeEntryPath)};
const rootDir = join(CHANNEL_HOME, 'profiles', PROFILE, 'upgrades');
const stateFile = join(rootDir, 'state.json');

function readState() {
  try {
    return JSON.parse(readFileSync(stateFile, 'utf8'));
  } catch (err) {
    if (err && err.code === 'ENOENT') return {};
    throw err;
  }
}

function writeState(state) {
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\\n', { mode: 0o600 });
}

function childCommand(state) {
  if (state.current && state.current.path) {
    return {
      node: process.execPath,
      args: [join(state.current.path, 'bin', 'lark-channel-bridge.mjs'), 'run', '--profile', PROFILE],
    };
  }
  return { node: FALLBACK_NODE, args: [FALLBACK_BRIDGE_ENTRY, 'run', '--profile', PROFILE] };
}

function rollbackState(state, message) {
  if (!state.previous) {
    const next = { ...state };
    delete next.pendingActivation;
    next.lastOperation = {
      kind: 'apply',
      status: 'failed',
      stage: 'activation',
      message,
      at: new Date().toISOString(),
    };
    writeState(next);
    return next;
  }
  const next = {
    current: state.previous,
    previous: state.current,
    lastOperation: {
      kind: 'apply',
      status: 'rolled_back',
      stage: 'activation',
      message,
      at: new Date().toISOString(),
    },
  };
  writeState(next);
  return next;
}

async function runOnce() {
  const state = readState();
  const command = childCommand(state);
  const child = spawn(command.node, command.args, {
    stdio: 'inherit',
    env: { ...process.env, LARK_CHANNEL_HOME: CHANNEL_HOME },
  });
  const pendingActivation = state.pendingActivation;
  let activationTimer;
  if (pendingActivation) {
    const deadline = Date.parse(pendingActivation.deadlineAt);
    const waitMs = Number.isFinite(deadline) ? Math.max(1, deadline - Date.now()) : 60000;
    activationTimer = setTimeout(() => {
      child.kill('SIGTERM');
      rollbackState(readState(), 'health-timeout');
    }, waitMs);
  }
  const forward = (signal) => child.kill(signal);
  process.once('SIGINT', forward);
  process.once('SIGTERM', forward);
  const code = await new Promise((resolve) => child.on('exit', (exitCode) => resolve(exitCode ?? 1)));
  if (activationTimer) clearTimeout(activationTimer);
  process.removeListener('SIGINT', forward);
  process.removeListener('SIGTERM', forward);
  const latest = readState();
  if (pendingActivation && latest.pendingActivation) {
    rollbackState(latest, 'child-exited-before-healthy');
    return 'retry';
  }
  process.exit(Number(code));
}

for (;;) {
  const action = await runOnce();
  if (action !== 'retry') break;
}
`;
}
```

This generated script intentionally uses only Node built-ins so it can survive package changes.

- [ ] **Step 5: Modify daemon input types and pure builders**

In `src/daemon/launchd.ts`, add `upgradeLauncherPath: string;` to `PlistInputs` and replace the program argument entry path with `inputs.upgradeLauncherPath`.

In `src/daemon/systemd.ts`, add `upgradeLauncherPath: string;` to `UnitInputs` and change `ExecStart` to:

```ts
ExecStart="${escape(inputs.nodePath)}" "${escape(inputs.upgradeLauncherPath)}" --profile "${escape(inputs.profile)}"
```

In `src/daemon/schtasks.ts`, add `upgradeLauncherPath: string;` to `LauncherInputs` and change the command line to:

```ts
`"${inputs.nodePath}" "${inputs.upgradeLauncherPath}" --profile "${inputs.profile}" >> "${daemonStdoutPath(inputs.profile)}" 2>> "${daemonStderrPath(inputs.profile)}"`,
```

- [ ] **Step 6: Install launcher before writing service files**

In each `writePlist`, `writeUnit`, and `writeLauncherCmd` function:

```ts
const appPaths = resolveAppPaths({ rootDir: paths.rootDir, profile });
const upgradePaths = resolveUpgradePaths(appPaths);
await writeUpgradeLauncherScript(upgradePaths.launcherFile, {
  profile,
  channelHome: paths.rootDir,
  fallbackNodePath: process.execPath,
  fallbackBridgeEntryPath: bridgeEntryPath,
});
```

Pass `upgradeLauncherPath: upgradePaths.launcherFile` into the pure builder.

Add imports where needed:

```ts
import { resolveAppPaths } from '../config/app-paths';
import { resolveUpgradePaths } from '../upgrade/paths';
import { writeUpgradeLauncherScript } from '../upgrade/launcher-script';
```

- [ ] **Step 7: Run task tests**

Run:

```bash
pnpm test tests/unit/upgrade/launcher-script.test.ts tests/unit/daemon/profile-args.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/upgrade/launcher-script.ts src/daemon/launchd.ts src/daemon/systemd.ts src/daemon/schtasks.ts tests/unit/upgrade/launcher-script.test.ts tests/unit/daemon/profile-args.test.ts
git commit -m "feat: install upgrade launcher for services"
```

---

### Task 4: Activation Health Marker

**Files:**
- Create: `src/upgrade/activation.ts`
- Modify: `src/cli/commands/start.ts`
- Test: `tests/unit/upgrade/activation.test.ts`
- Test: `tests/unit/cli/start-agent-factory.test.ts`

- [ ] **Step 1: Write failing activation tests**

Create `tests/unit/upgrade/activation.test.ts`:

```ts
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
```

- [ ] **Step 2: Add startup wiring static test**

Add to `tests/unit/cli/start-agent-factory.test.ts`:

```ts
it('marks upgrade activation healthy after bot identity is backfilled', async () => {
  const source = await readFile(join(process.cwd(), 'src/cli/commands/start.ts'), 'utf8');
  const botNameIndex = source.indexOf('const botName = bridge.channel.botIdentity?.name;');
  const markIndex = source.indexOf('await markUpgradeActivationHealthy', botNameIndex);

  expect(botNameIndex).toBeGreaterThanOrEqual(0);
  expect(markIndex).toBeGreaterThan(botNameIndex);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
pnpm test tests/unit/upgrade/activation.test.ts tests/unit/cli/start-agent-factory.test.ts
```

Expected: FAIL because activation marker is missing.

- [ ] **Step 4: Implement activation marker**

Create `src/upgrade/activation.ts`:

```ts
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
```

- [ ] **Step 5: Wire activation marker into startup**

Modify `src/cli/commands/start.ts` imports:

```ts
import { markUpgradeActivationHealthy } from '../../upgrade/activation';
import { resolveUpgradePaths } from '../../upgrade/paths';
import { loadUpgradeState } from '../../upgrade/state';
```

Add helper near the bottom:

```ts
async function currentUpgradeCommit(appPaths: Pick<AppPaths, 'profileDir'>): Promise<string | undefined> {
  const state = await loadUpgradeState(resolveUpgradePaths(appPaths).stateFile);
  return state.current?.commit;
}
```

After the existing `botName` registry backfill block, add:

```ts
await markUpgradeActivationHealthy(appPaths, await currentUpgradeCommit(appPaths)).catch((err) =>
  log.warn('upgrade', 'activation-mark-failed', { err: String(err) }),
);
```

- [ ] **Step 6: Run task tests**

Run:

```bash
pnpm test tests/unit/upgrade/activation.test.ts tests/unit/cli/start-agent-factory.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/upgrade/activation.ts src/cli/commands/start.ts tests/unit/upgrade/activation.test.ts tests/unit/cli/start-agent-factory.test.ts
git commit -m "feat: mark healthy upgrade activations"
```

---

### Task 5: Upgrade Manager Check, Apply, And Rollback

**Files:**
- Create: `src/upgrade/manager.ts`
- Test: `tests/unit/upgrade/manager.test.ts`

- [ ] **Step 1: Write failing manager tests**

Create `tests/unit/upgrade/manager.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { UpgradeManager } from '../../../src/upgrade/manager';
import { resolveUpgradePaths } from '../../../src/upgrade/paths';
import { loadUpgradeState, saveUpgradeState } from '../../../src/upgrade/state';

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
    h.run.mockResolvedValueOnce({ ok: true, stdout: 'Update title\nAlice\n2026-06-20T00:00:00.000Z\n', stderr: '' });

    const result = await h.manager.check();

    expect(result.status).toBe('update');
    expect(result.targetCommit).toBe('abc123');
    expect(h.run.mock.calls.map((call) => call[0])).toEqual(['git', 'git', 'git']);
    expect(h.run.mock.calls[0][1]).toEqual(['-C', h.currentPath, 'fetch', 'origin', 'refs/heads/release:refs/remotes/origin/release']);
  });

  it('does not switch current when verification fails', async () => {
    const h = await harness({ enabled: true });
    await saveUpgradeState(h.paths.stateFile, {
      current: { commit: 'old', path: h.currentPath },
    });
    h.run.mockResolvedValueOnce({ ok: true, stdout: '', stderr: '' });
    h.run.mockResolvedValueOnce({ ok: true, stdout: 'new\n', stderr: '' });
    h.run.mockResolvedValueOnce({ ok: true, stdout: 'https://github.com/doge-liang/lark-coding-agent-bridge.git\n', stderr: '' });
    h.run.mockResolvedValueOnce({ ok: true, stdout: '', stderr: '' });
    h.run.mockResolvedValueOnce({ ok: true, stdout: 'new\n', stderr: '' });
    h.run.mockResolvedValueOnce({ ok: true, stdout: '', stderr: '' });
    h.run.mockResolvedValueOnce({ ok: false, stdout: '', stderr: 'type error' });

    const result = await h.manager.apply();

    expect(result.status).toBe('failed');
    expect(result.stage).toBe('typecheck');
    expect((await loadUpgradeState(h.paths.stateFile)).current?.commit).toBe('old');
    expect(h.restart).not.toHaveBeenCalled();
  });

  it('writes pending activation and requests restart after verification passes', async () => {
    const h = await harness({ enabled: true });
    await saveUpgradeState(h.paths.stateFile, {
      current: { commit: 'old', path: h.currentPath },
    });
    h.run
      .mockResolvedValueOnce({ ok: true, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ ok: true, stdout: 'new\n', stderr: '' })
      .mockResolvedValueOnce({ ok: true, stdout: 'https://github.com/doge-liang/lark-coding-agent-bridge.git\n', stderr: '' })
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
    expect(h.restart).toHaveBeenCalledTimes(1);
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
    expect(h.restart).toHaveBeenCalledTimes(1);
  });
});

async function harness(overrides: Partial<ReturnType<typeof createDefaultProfileConfig>['upgrade']> = {}) {
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
  profileConfig.upgrade = { ...profileConfig.upgrade, ...overrides };
  const paths = resolveUpgradePaths(appPaths);
  const run = vi.fn();
  const restart = vi.fn();
  const manager = new UpgradeManager({
    appPaths,
    profileConfig,
    currentPath,
    runCommand: run,
    restartService: restart,
    now: () => new Date('2026-06-20T00:00:00.000Z'),
    operationId: () => 'op-1',
  });
  return { root, appPaths, profileConfig, paths, currentPath, run, restart, manager };
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm test tests/unit/upgrade/manager.test.ts
```

Expected: FAIL because `UpgradeManager` does not exist.

- [ ] **Step 3: Implement manager result types and constructor**

Create `src/upgrade/manager.ts` with constructor dependencies:

```ts
import { mkdir, rename, rm } from 'node:fs/promises';
import type { AppPaths } from '../config/app-paths';
import type { ProfileConfig } from '../config/profile-schema';
import type { ServiceResult } from '../daemon/service-adapter';
import { spawnProcess } from '../platform/spawn';
import { resolveUpgradePaths, type UpgradePaths } from './paths';
import {
  loadUpgradeState,
  markActivationRolledBack,
  saveUpgradeState,
  setPendingActivation,
  withUpgradeLock,
  type UpgradeState,
} from './state';

export interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export type RunCommand = (command: string, args: string[], opts?: { cwd?: string; logFile?: string }) => Promise<CommandResult>;

export interface UpgradeManagerOptions {
  appPaths: Pick<AppPaths, 'profile' | 'profileDir'>;
  profileConfig: ProfileConfig;
  currentPath: string;
  runCommand?: RunCommand;
  restartService: () => Promise<ServiceResult> | ServiceResult;
  now?: () => Date;
  operationId?: () => string;
}

export class UpgradeManager {
  private readonly paths: UpgradePaths;
  private readonly runCommand: RunCommand;
  private readonly now: () => Date;
  private readonly operationId: () => string;

  constructor(private readonly opts: UpgradeManagerOptions) {
    this.paths = resolveUpgradePaths(opts.appPaths);
    this.runCommand = opts.runCommand ?? defaultRunCommand;
    this.now = opts.now ?? (() => new Date());
    this.operationId = opts.operationId ?? (() => `op-${Date.now().toString(36)}`);
  }
}
```

- [ ] **Step 4: Implement status and check**

Add methods to `UpgradeManager`:

```ts
async status(): Promise<{
  enabled: boolean;
  remote: string;
  branch: string;
  requireTests: boolean;
  healthTimeoutMs: number;
  state: UpgradeState;
}> {
  return {
    enabled: this.opts.profileConfig.upgrade.enabled,
    remote: this.opts.profileConfig.upgrade.remote,
    branch: this.opts.profileConfig.upgrade.branch,
    requireTests: this.opts.profileConfig.upgrade.requireTests,
    healthTimeoutMs: this.opts.profileConfig.upgrade.healthTimeoutMs,
    state: await loadUpgradeState(this.paths.stateFile),
  };
}

async check(): Promise<{
  status: 'disabled' | 'current' | 'update' | 'failed';
  targetCommit?: string;
  title?: string;
  author?: string;
  date?: string;
  message?: string;
}> {
  if (!this.opts.profileConfig.upgrade.enabled) return { status: 'disabled', message: 'upgrade disabled' };
  const remote = this.opts.profileConfig.upgrade.remote;
  const branch = this.opts.profileConfig.upgrade.branch;
  const remoteRef = `refs/remotes/${remote}/${branch}`;
  const fetchRef = `refs/heads/${branch}:${remoteRef}`;
  const fetch = await this.runCommand('git', ['-C', this.opts.currentPath, 'fetch', remote, fetchRef]);
  if (!fetch.ok) return { status: 'failed', message: fetch.stderr || fetch.stdout || 'git fetch failed' };
  const rev = await this.runCommand('git', ['-C', this.opts.currentPath, 'rev-parse', remoteRef]);
  if (!rev.ok) return { status: 'failed', message: rev.stderr || 'cannot resolve release ref' };
  const targetCommit = rev.stdout.trim();
  const state = await loadUpgradeState(this.paths.stateFile);
  if (state.current?.commit === targetCommit) return { status: 'current', targetCommit };
  const show = await this.runCommand('git', ['-C', this.opts.currentPath, 'show', '-s', '--format=%s%n%an%n%cI', targetCommit]);
  const [title, author, date] = show.stdout.trim().split('\\n');
  return { status: 'update', targetCommit, title, author, date };
}
```

- [ ] **Step 5: Implement apply and rollback**

Add methods to `UpgradeManager`:

```ts
async apply(): Promise<{ status: 'ok' | 'disabled' | 'failed'; stage: string; message: string; logPath?: string }> {
  if (!this.opts.profileConfig.upgrade.enabled) {
    return { status: 'disabled', stage: 'config', message: 'upgrade disabled' };
  }
  return withUpgradeLock(this.paths.lockFile, async () => {
    const op = this.operationId();
    const logPath = this.paths.logFile(op);
    const remote = this.opts.profileConfig.upgrade.remote;
    const branch = this.opts.profileConfig.upgrade.branch;
    const remoteRef = `refs/remotes/${remote}/${branch}`;
    const fetchRef = `refs/heads/${branch}:${remoteRef}`;
    const commands: Array<{ stage: string; command: string; args: string[]; cwd?: string }> = [
      { stage: 'fetch', command: 'git', args: ['-C', this.opts.currentPath, 'fetch', remote, fetchRef] },
      { stage: 'resolve', command: 'git', args: ['-C', this.opts.currentPath, 'rev-parse', remoteRef] },
    ];
    let targetCommit = '';
    for (const step of commands) {
      const result = await this.runCommand(step.command, step.args, { cwd: step.cwd, logFile: logPath });
      if (!result.ok) return this.fail(step.stage, result.stderr || result.stdout, logPath);
      if (step.stage === 'resolve') targetCommit = result.stdout.trim();
    }
    const stagingDir = this.paths.stagingDir(op);
    const releaseDir = this.paths.releaseDir(targetCommit);
    const remoteUrl = await this.runCommand('git', ['-C', this.opts.currentPath, 'config', '--get', `remote.${remote}.url`], { logFile: logPath });
    if (!remoteUrl.ok) return this.fail('source', remoteUrl.stderr || remoteUrl.stdout || 'cannot resolve configured remote url', logPath);
    await rm(stagingDir, { recursive: true, force: true });
    await mkdir(stagingDir, { recursive: true });
    const archive = await this.runCommand('git', ['clone', '--branch', branch, '--depth', '1', remoteUrl.stdout.trim(), stagingDir], { logFile: logPath });
    if (!archive.ok) return this.fail('stage', archive.stderr || archive.stdout, logPath);
    const stagedHead = await this.runCommand('git', ['-C', stagingDir, 'rev-parse', 'HEAD'], { logFile: logPath });
    if (!stagedHead.ok) return this.fail('stage', stagedHead.stderr || stagedHead.stdout || 'cannot resolve staged HEAD', logPath);
    if (stagedHead.stdout.trim() !== targetCommit) {
      await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
      return this.fail('stage', `staged HEAD ${stagedHead.stdout.trim()} does not match target ${targetCommit}`, logPath);
    }
    for (const step of this.verificationCommands(stagingDir)) {
      const result = await this.runCommand(step.command, step.args, { cwd: stagingDir, logFile: logPath });
      if (!result.ok) {
        await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
        return this.fail(step.stage, result.stderr || result.stdout, logPath);
      }
    }
    await rm(releaseDir, { recursive: true, force: true });
    await mkdir(this.paths.releasesDir, { recursive: true });
    await rename(stagingDir, releaseDir);
    const state = await loadUpgradeState(this.paths.stateFile);
    await saveUpgradeState(this.paths.stateFile, setPendingActivation(state, {
      commit: targetCommit,
      path: releaseDir,
      previousCommit: state.current?.commit,
      previousPath: state.current?.path,
      now: this.now(),
      healthTimeoutMs: this.opts.profileConfig.upgrade.healthTimeoutMs,
      operationId: op,
    }));
    const restart = await this.opts.restartService();
    if (!restart.ok) return this.fail('restart', restart.stderr || 'service restart failed', logPath);
    return { status: 'ok', stage: 'restart', message: 'restart requested', logPath };
  });
}

async rollback(): Promise<{ status: 'ok' | 'failed'; stage: string; message: string }> {
  return withUpgradeLock(this.paths.lockFile, async () => {
    const state = await loadUpgradeState(this.paths.stateFile);
    if (!state.previous) return { status: 'failed', stage: 'state', message: 'no previous release' };
    await saveUpgradeState(this.paths.stateFile, markActivationRolledBack(state, 'manual rollback', this.now()));
    const restart = await this.opts.restartService();
    if (!restart.ok) return { status: 'failed', stage: 'restart', message: restart.stderr || 'service restart failed' };
    return { status: 'ok', stage: 'restart', message: 'restart requested' };
  });
}

private verificationCommands(cwd: string): Array<{ stage: string; command: string; args: string[]; cwd: string }> {
  const commands = [
    { stage: 'install', command: 'pnpm', args: ['install', '--frozen-lockfile'], cwd },
    { stage: 'typecheck', command: 'pnpm', args: ['typecheck'], cwd },
    { stage: 'build', command: 'pnpm', args: ['build'], cwd },
  ];
  if (this.opts.profileConfig.upgrade.requireTests) {
    commands.push({ stage: 'test', command: 'pnpm', args: ['test'], cwd });
  }
  return commands;
}

private async fail(stage: string, message: string, logPath?: string) {
  return { status: 'failed' as const, stage, message: message.trim() || `${stage} failed`, ...(logPath ? { logPath } : {}) };
}
```

Add default command runner:

```ts
async function defaultRunCommand(command: string, args: string[], opts: { cwd?: string; logFile?: string } = {}): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawnProcess(command, args, { cwd: opts.cwd, env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (err) => resolve({ ok: false, stdout, stderr: err.message }));
    child.on('exit', (code) => resolve({ ok: code === 0, stdout, stderr }));
  });
}
```

- [ ] **Step 6: Run task tests**

Run:

```bash
pnpm test tests/unit/upgrade/manager.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/upgrade/manager.ts tests/unit/upgrade/manager.test.ts
git commit -m "feat: add upgrade manager"
```

---

### Task 6: Lark `/upgrade` Command

**Files:**
- Create: `src/upgrade/command-service.ts`
- Modify: `src/commands/index.ts`
- Test: `tests/integration/commands/upgrade-command.test.ts`

- [ ] **Step 1: Write failing command tests**

Create `tests/integration/commands/upgrade-command.test.ts` by copying the harness style from `tests/integration/commands/commands-v1.test.ts`, then use these tests:

```ts
it('allows owner/admin p2p upgrade check', async () => {
  const h = await createHarness();
  h.upgrade.check.mockResolvedValue('可升级到 `abc123`。');

  await expect(h.run('/upgrade check')).resolves.toBe(true);

  expect(h.upgrade.check).toHaveBeenCalledTimes(1);
  expect(lastMarkdown(h.channel)).toContain('abc123');
});

it('rejects upgrade from group chat even for admin', async () => {
  const h = await createHarness();

  await expect(h.run('/upgrade check', { chatMode: 'group' })).resolves.toBe(true);

  expect(h.upgrade.check).not.toHaveBeenCalled();
  expect(lastMarkdown(h.channel)).toContain('请私聊 bot 使用');
});

it('rejects upgrade for non-admin p2p users', async () => {
  const h = await createHarness();

  await expect(h.run('/upgrade check', { senderId: 'ou-user' })).resolves.toBe(true);

  expect(h.upgrade.check).not.toHaveBeenCalled();
  expect(lastMarkdown(h.channel)).toContain('仅管理员可用');
});

it('runs upgrade apply and rollback through the command service', async () => {
  const h = await createHarness();
  h.upgrade.apply.mockResolvedValue('已切换到 `abc123`，正在重启。');
  h.upgrade.rollback.mockResolvedValue('已切回 `old`，正在重启。');

  await expect(h.run('/upgrade apply')).resolves.toBe(true);
  expect(lastMarkdown(h.channel)).toContain('abc123');

  await expect(h.run('/upgrade rollback')).resolves.toBe(true);
  expect(lastMarkdown(h.channel)).toContain('old');
});
```

In the harness, add:

```ts
const upgrade = {
  status: vi.fn(async () => '当前版本: `abc123`'),
  check: vi.fn(async () => '已是最新。'),
  apply: vi.fn(async () => '已切换，正在重启。'),
  rollback: vi.fn(async () => '已回滚，正在重启。'),
};
```

Pass `upgradeCommandService: upgrade` into `tryHandleCommand()` context.

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm test tests/integration/commands/upgrade-command.test.ts
```

Expected: FAIL because `/upgrade` is not registered and `CommandContext` has no service injection.

- [ ] **Step 3: Implement command-service formatter**

Create `src/upgrade/command-service.ts`:

```ts
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CommandContext } from '../commands';
import { resolveAppPaths } from '../config/app-paths';
import { getServiceAdapter } from '../daemon/service-adapter';
import { UpgradeManager } from './manager';

export interface UpgradeCommandService {
  status(): Promise<string>;
  check(): Promise<string>;
  apply(): Promise<string>;
  rollback(): Promise<string>;
}

export function createUpgradeCommandService(ctx: CommandContext): UpgradeCommandService {
  const adapter = getServiceAdapter(ctx.controls.profile);
  const rootDir = dirname(ctx.controls.configPath);
  const appPaths = resolveAppPaths({ rootDir, profile: ctx.controls.profile });
  const manager = new UpgradeManager({
    appPaths,
    profileConfig: ctx.controls.profileConfig,
    currentPath: currentBridgeRoot(),
    restartService: () => adapter ? adapter.restart() : { ok: false, stderr: '当前系统不支持后台 service restart' },
  });
  return {
    status: async () => formatStatus(await manager.status()),
    check: async () => formatCheck(await manager.check()),
    apply: async () => formatApply(await manager.apply()),
    rollback: async () => formatApply(await manager.rollback()),
  };
}

function currentBridgeRoot(): string {
  return dirname(dirname(dirname(fileURLToPath(import.meta.url))));
}
```

Add formatter functions in the same file:

```ts
function formatStatus(status: Awaited<ReturnType<UpgradeManager['status']>>): string {
  const current = status.state.current?.commit ?? '未记录';
  const previous = status.state.previous?.commit ?? '无';
  const pending = status.state.pendingActivation?.commit ?? '无';
  return [
    `当前版本: \`${current}\``,
    `上一版本: \`${previous}\``,
    `待激活: \`${pending}\``,
    `升级源: \`${status.remote}/${status.branch}\``,
    `完整测试: \`${status.requireTests ? 'on' : 'off'}\``,
  ].join('\n');
}

function formatCheck(result: Awaited<ReturnType<UpgradeManager['check']>>): string {
  if (result.status === 'disabled') return '自更新未启用。';
  if (result.status === 'current') return `已是最新版本: \`${result.targetCommit}\``;
  if (result.status === 'failed') return `❌ 检查失败: ${result.message}`;
  return [
    `可升级到 \`${result.targetCommit}\`。`,
    result.title ? `提交: ${result.title}` : '',
    result.author ? `作者: ${result.author}` : '',
    result.date ? `时间: ${result.date}` : '',
  ].filter(Boolean).join('\n');
}

function formatApply(result: { status: string; stage: string; message: string; logPath?: string }): string {
  if (result.status === 'ok') return `已处理: ${result.message}`;
  if (result.status === 'disabled') return '自更新未启用。';
  return [`❌ 升级失败: ${result.stage}`, result.message, result.logPath ? `日志: \`${result.logPath}\`` : '']
    .filter(Boolean)
    .join('\n');
}
```

- [ ] **Step 4: Register command with stricter p2p gate**

Modify `src/commands/index.ts`:

```ts
import { createUpgradeCommandService, type UpgradeCommandService } from '../upgrade/command-service';
```

Add to `CommandContext`:

```ts
upgradeCommandService?: UpgradeCommandService;
```

Add handler registration:

```ts
'/upgrade': handleUpgrade,
```

Add `/upgrade` to `ADMIN_COMMANDS`.

Add handler near other command handlers:

```ts
async function handleUpgrade(args: string, ctx: CommandContext): Promise<void> {
  if (ctx.chatMode !== 'p2p') {
    await reply(ctx, '❌ 请私聊 bot 使用 `/upgrade`。');
    return;
  }
  const service = ctx.upgradeCommandService ?? createUpgradeCommandService(ctx);
  const [sub = 'status'] = args.trim().split(/\s+/).filter(Boolean);
  if (sub === 'status') return reply(ctx, await service.status());
  if (sub === 'check') return reply(ctx, await service.check());
  if (sub === 'apply') return reply(ctx, await service.apply());
  if (sub === 'rollback') return reply(ctx, await service.rollback());
  await reply(ctx, '用法: `/upgrade [status|check|apply|rollback]`');
}
```

- [ ] **Step 5: Run task tests**

Run:

```bash
pnpm test tests/integration/commands/upgrade-command.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/upgrade/command-service.ts src/commands/index.ts tests/integration/commands/upgrade-command.test.ts
git commit -m "feat: add upgrade chat command"
```

---

### Task 7: Documentation And Verification

**Files:**
- Modify: `README.md`
- Modify: `README.zh.md`
- Test: existing docs/static tests

- [ ] **Step 1: Update README command tables**

In `README.md`, add a row near other slash commands:

```markdown
| `/upgrade [status|check|apply|rollback]` | Owner/admin DM-only controlled self-update from the configured release branch |
```

In `README.zh.md`, add:

```markdown
| `/upgrade [status|check|apply|rollback]` | 仅 owner/admin 私聊可用；从配置的 release 分支执行受控自更新 |
```

- [ ] **Step 2: Add safety note**

In both READMEs, add a short paragraph after the command table.

English:

```markdown
`/upgrade` does not run arbitrary agent shell commands. It stages the configured release branch, verifies the build, switches the profile-local launcher state, and rolls back automatically if the new bridge cannot reconnect.
```

Chinese:

```markdown
`/upgrade` 不会让 agent 执行任意 shell 更新命令。它只会拉取配置好的 release 分支，在 staging 中完成校验，通过后切换 profile-local launcher 状态；如果新版本无法重新连接，launcher 会自动回滚。
```

- [ ] **Step 3: Run focused tests**

Run:

```bash
pnpm test tests/unit/config/profile-schema.test.ts tests/unit/upgrade/paths.test.ts tests/unit/upgrade/state.test.ts tests/unit/upgrade/launcher-script.test.ts tests/unit/upgrade/activation.test.ts tests/unit/upgrade/manager.test.ts tests/unit/daemon/profile-args.test.ts tests/unit/cli/start-agent-factory.test.ts tests/integration/commands/upgrade-command.test.ts tests/unit/docs/readme-contract.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run full verification**

Run:

```bash
pnpm typecheck
pnpm build
pnpm test
```

Expected: all commands pass.

- [ ] **Step 5: Commit**

```bash
git add README.md README.zh.md
git commit -m "docs: document controlled self update"
```

---

## Final Review Checklist

- [ ] `/upgrade` is owner/admin and p2p-only.
- [ ] Chat input cannot supply remote URLs, branches, refs, or commits.
- [ ] `apply` never mutates the current release directory in place.
- [ ] Verification failure leaves `state.current` unchanged.
- [ ] Service definitions point to profile-local `launcher.mjs`.
- [ ] `runStart()` marks activation healthy only after bot identity is available.
- [ ] Launcher rolls back on early child exit and health timeout.
- [ ] `pnpm typecheck`, `pnpm build`, and `pnpm test` pass.

## Plan Self-Review

- Spec coverage: command surface, profile config, runtime state, launcher
  activation, automatic rollback, service integration, security boundaries,
  error handling, release retention, tests, and README updates are represented
  by the tasks above.
- Placeholder scan: no incomplete task markers are intentionally left in the
  instructions beyond the executable checkbox syntax.
- Type consistency: the plan uses `UpgradeConfig`, `UpgradeState`,
  `UpgradeManager`, `UpgradeCommandService`, and `UpgradePaths` consistently
  across tests and implementation steps.
- Gaps: none identified.
