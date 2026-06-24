import { appendFile, mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AppPaths } from '../config/app-paths';
import type { ProfileConfig } from '../config/profile-schema';
import type { ServiceResult } from '../daemon/service-adapter';
import { spawnProcess } from '../platform/spawn';
import { resolveUpgradePaths } from './paths';
import {
  loadUpgradeState,
  saveUpgradeState,
  setPendingActivation,
  withUpgradeLock,
  type UpgradeActivationNotify,
  type UpgradeLastOperation,
  type UpgradeState,
} from './state';

export interface UpgradeCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export interface UpgradeRunCommandOptions {
  cwd?: string;
  logPath?: string;
}

export type UpgradeRunCommand = (
  command: string,
  args: readonly string[],
  options?: UpgradeRunCommandOptions,
) => Promise<UpgradeCommandResult> | UpgradeCommandResult;

export interface UpgradeManagerOptions {
  appPaths: Pick<AppPaths, 'profile' | 'profileDir'>;
  profileConfig: ProfileConfig;
  currentPath: string;
  runCommand?: UpgradeRunCommand;
  restartService: () => Promise<ServiceResult> | ServiceResult;
  refreshLauncher?: () => Promise<void> | void;
  activationNotify?: UpgradeActivationNotify;
  now?: () => Date;
  operationId?: () => string;
}

export interface UpgradeStatus {
  enabled: boolean;
  remote: string;
  branch: string;
  requireTests: boolean;
  healthTimeoutMs: number;
  state: UpgradeState;
}

export type UpgradeCheckResult =
  | (UpgradeStatus & { status: 'disabled' })
  | {
      status: 'current' | 'update' | 'failed';
      enabled: true;
      remote: string;
      branch: string;
      currentCommit?: string;
      targetCommit?: string;
      title?: string;
      author?: string;
      committedAt?: string;
      stage?: string;
      message?: string;
    };

export type UpgradeApplyResult =
  | { status: 'disabled'; enabled: false }
  | { status: 'ok'; targetCommit: string; releasePath: string; logPath: string }
  | { status: 'restart_failed'; targetCommit: string; releasePath: string; logPath: string; stderr: string }
  | { status: 'current'; targetCommit: string; logPath: string }
  | { status: 'failed'; stage: string; message: string; logPath: string };

export type UpgradeRollbackResult =
  | { status: 'disabled'; enabled: false }
  | { status: 'ok'; currentCommit: string }
  | { status: 'restart_failed'; currentCommit: string; stderr: string }
  | { status: 'failed'; stage: string; message: string };

export class UpgradeManager {
  private readonly paths;
  private readonly runCommand: UpgradeRunCommand;
  private readonly now: () => Date;
  private readonly operationId: () => string;

  constructor(private readonly options: UpgradeManagerOptions) {
    this.paths = resolveUpgradePaths(options.appPaths);
    this.runCommand = options.runCommand ?? runUpgradeCommand;
    this.now = options.now ?? (() => new Date());
    this.operationId = options.operationId ?? defaultOperationId;
  }

  async status(): Promise<UpgradeStatus> {
    const upgrade = this.options.profileConfig.upgrade;
    return {
      enabled: upgrade.enabled,
      remote: upgrade.remote,
      branch: upgrade.branch,
      requireTests: upgrade.requireTests,
      healthTimeoutMs: upgrade.healthTimeoutMs,
      state: await loadUpgradeState(this.paths.stateFile),
    };
  }

  async check(): Promise<UpgradeCheckResult> {
    const base = await this.status();
    if (!base.enabled) return { ...base, status: 'disabled' };

    try {
      const targetCommit = await this.fetchAndResolve(base.remote, base.branch);
      const state = await loadUpgradeState(this.paths.stateFile);
      const currentCommit = state.current?.commit;
      const metadata = await this.readCommitMetadata(targetCommit);
      return {
        status: currentCommit === targetCommit ? 'current' : 'update',
        enabled: true,
        remote: base.remote,
        branch: base.branch,
        ...(currentCommit ? { currentCommit } : {}),
        targetCommit,
        ...metadata,
      };
    } catch (err) {
      return {
        status: 'failed',
        enabled: true,
        remote: base.remote,
        branch: base.branch,
        stage: err instanceof UpgradeCommandError ? err.stage : 'check',
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async apply(): Promise<UpgradeApplyResult> {
    if (!this.options.profileConfig.upgrade.enabled) return { status: 'disabled', enabled: false };

    type PendingRestart = {
      status: 'pending_restart';
      targetCommit: string;
      releasePath: string;
      logPath: string;
    };
    const switched = await withUpgradeLock<UpgradeApplyResult | PendingRestart>(this.paths.lockFile, async () => {
      const operationId = this.operationId();
      const logPath = this.paths.logFile(operationId);
      const staging = this.paths.stagingDir(operationId);
      await mkdir(dirname(logPath), { recursive: true });
      await rm(staging, { recursive: true, force: true });

      const fail = async (stage: string, message: string): Promise<UpgradeApplyResult> => {
        await rm(staging, { recursive: true, force: true });
        await this.recordLastOperation('apply', 'failed', stage, message, logPath);
        return { status: 'failed', stage, message, logPath };
      };

      try {
        const { remote, branch } = this.options.profileConfig.upgrade;
        const targetCommit = await this.fetchAndResolve(remote, branch, logPath);
        const stateBeforeSwitch = await loadUpgradeState(this.paths.stateFile);
        if (stateBeforeSwitch.current?.commit === targetCommit) {
          await rm(staging, { recursive: true, force: true });
          return { status: 'current', targetCommit, logPath };
        }

        const remoteUrl = await this.remoteUrl(remote, logPath);
        await mkdir(staging, { recursive: true });
        await this.runChecked('clone', 'git', ['clone', '--branch', branch, '--single-branch', remoteUrl, staging], {
          logPath,
        });
        const stagedHead = await this.runChecked('stage', 'git', ['-C', staging, 'rev-parse', 'HEAD'], {
          logPath,
        });
        if (stagedHead.stdout.trim() !== targetCommit) {
          return fail('stage', `staged HEAD ${stagedHead.stdout.trim()} did not match target ${targetCommit}`);
        }

        const verification = await this.verify(staging, logPath);
        if (verification) return fail(verification.stage, verification.message);

        const releasePath = this.paths.releaseDir(targetCommit);
        await mkdir(this.paths.releasesDir, { recursive: true });
        await rm(releasePath, { recursive: true, force: true });
        await rename(staging, releasePath);
        try {
          await this.options.refreshLauncher?.();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return fail('launcher', message);
        }

        const state = await loadUpgradeState(this.paths.stateFile);
        const next = setPendingActivation(state, {
          commit: targetCommit,
          path: releasePath,
          previousCommit: state.current?.commit,
          previousPath: state.current?.path,
          now: this.now(),
          healthTimeoutMs: this.options.profileConfig.upgrade.healthTimeoutMs,
          operationId,
          ...(this.options.activationNotify ? { notify: this.options.activationNotify } : {}),
        });
        next.lastOperation = {
          kind: 'apply',
          status: 'ok',
          stage: 'switch',
          message: 'pending activation written',
          logPath,
          at: this.now().toISOString(),
        };
        await saveUpgradeState(this.paths.stateFile, next);

        return { status: 'pending_restart', targetCommit, releasePath, logPath };
      } catch (err) {
        const stage = err instanceof UpgradeCommandError ? err.stage : 'apply';
        const message = err instanceof Error ? err.message : String(err);
        return fail(stage, message);
      }
    });
    if (switched.status !== 'pending_restart') return switched;

    const restart = await this.options.restartService();
    if (!restart.ok) {
      await withUpgradeLock(this.paths.lockFile, () =>
        this.recordLastOperation('apply', 'failed', 'restart', restart.stderr, switched.logPath),
      );
      return {
        status: 'restart_failed',
        targetCommit: switched.targetCommit,
        releasePath: switched.releasePath,
        logPath: switched.logPath,
        stderr: restart.stderr,
      };
    }
    return {
      status: 'ok',
      targetCommit: switched.targetCommit,
      releasePath: switched.releasePath,
      logPath: switched.logPath,
    };
  }

  async rollback(): Promise<UpgradeRollbackResult> {
    if (!this.options.profileConfig.upgrade.enabled) return { status: 'disabled', enabled: false };

    type PendingRollbackRestart = {
      status: 'pending_restart';
      currentCommit: string;
      state: UpgradeState;
    };
    const switched = await withUpgradeLock<UpgradeRollbackResult | PendingRollbackRestart>(this.paths.lockFile, async () => {
      const state = await loadUpgradeState(this.paths.stateFile);
      if (!state.previous) {
        return { status: 'failed', stage: 'rollback', message: 'no previous release to roll back to' };
      }

      const next: UpgradeState = {
        current: state.previous,
        lastOperation: {
          kind: 'rollback',
          status: 'ok',
          stage: 'switch',
          message: 'rolled back to previous release',
          at: this.now().toISOString(),
        },
      };
      await saveUpgradeState(this.paths.stateFile, next);

      return { status: 'pending_restart', currentCommit: state.previous.commit, state: next };
    });
    if (switched.status !== 'pending_restart') return switched;

    const restart = await this.options.restartService();
    if (!restart.ok) {
      await withUpgradeLock(this.paths.lockFile, () =>
        saveUpgradeState(this.paths.stateFile, {
          ...switched.state,
          lastOperation: {
            kind: 'rollback',
            status: 'failed',
            stage: 'restart',
            message: restart.stderr,
            at: this.now().toISOString(),
          },
        }),
      );
      return { status: 'restart_failed', currentCommit: switched.currentCommit, stderr: restart.stderr };
    }

    return { status: 'ok', currentCommit: switched.currentCommit };
  }

  private async fetchAndResolve(remote: string, branch: string, logPath?: string): Promise<string> {
    assertSafeGitName(remote, 'remote');
    assertSafeGitName(branch, 'branch');
    await this.runChecked(
      'fetch',
      'git',
      ['-C', this.options.currentPath, 'fetch', remote, `refs/heads/${branch}:refs/remotes/${remote}/${branch}`],
      { logPath },
    );
    const resolved = await this.runChecked(
      'resolve',
      'git',
      ['-C', this.options.currentPath, 'rev-parse', `refs/remotes/${remote}/${branch}`],
      { logPath },
    );
    return resolved.stdout.trim();
  }

  private async readCommitMetadata(commit: string): Promise<{ title?: string; author?: string; committedAt?: string }> {
    const shown = await this.runChecked(
      'metadata',
      'git',
      ['-C', this.options.currentPath, 'show', '-s', '--format=%s%n%an%n%cI', commit],
    );
    const [title, author, committedAt] = shown.stdout.replace(/\r\n/g, '\n').split('\n');
    return {
      ...(title ? { title } : {}),
      ...(author ? { author } : {}),
      ...(committedAt ? { committedAt } : {}),
    };
  }

  private async remoteUrl(remote: string, logPath: string): Promise<string> {
    const result = await this.runChecked(
      'source',
      'git',
      ['-C', this.options.currentPath, 'config', '--get', `remote.${remote}.url`],
      { logPath },
    );
    const remoteUrl = result.stdout.trim();
    if (!remoteUrl) throw new UpgradeCommandError('source', `remote ${remote} has no configured URL`);
    return remoteUrl;
  }

  private async verify(staging: string, logPath: string): Promise<{ stage: string; message: string } | undefined> {
    const commands: Array<{ stage: string; args: readonly string[] }> = [
      { stage: 'install', args: ['install', '--frozen-lockfile'] },
      { stage: 'typecheck', args: ['typecheck'] },
      { stage: 'build', args: ['build'] },
    ];
    if (this.options.profileConfig.upgrade.requireTests) {
      commands.push({ stage: 'test', args: ['test'] });
    }

    for (const command of commands) {
      const result = await this.runCommand('pnpm', command.args, { cwd: staging, logPath });
      if (!result.ok) return { stage: command.stage, message: result.stderr || result.stdout };
    }
    return undefined;
  }

  private async runChecked(
    stage: string,
    command: string,
    args: readonly string[],
    options?: UpgradeRunCommandOptions,
  ): Promise<UpgradeCommandResult> {
    const result = await this.runCommand(command, args, options);
    if (!result.ok) throw new UpgradeCommandError(stage, result.stderr || result.stdout);
    return result;
  }

  private async recordLastOperation(
    kind: UpgradeLastOperation['kind'],
    status: UpgradeLastOperation['status'],
    stage: string,
    message: string,
    logPath?: string,
  ): Promise<void> {
    const state = await loadUpgradeState(this.paths.stateFile);
    await saveUpgradeState(this.paths.stateFile, {
      ...state,
      lastOperation: {
        kind,
        status,
        stage,
        message,
        ...(logPath ? { logPath } : {}),
        at: this.now().toISOString(),
      },
    });
  }
}

export async function runUpgradeCommand(
  command: string,
  args: readonly string[] = [],
  options: UpgradeRunCommandOptions = {},
): Promise<UpgradeCommandResult> {
  if (options.logPath) {
    await appendCommandLog(options.logPath, command, args, options.cwd);
  }

  return new Promise((resolve) => {
    const child = spawnProcess(command, args, { cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer | string) => stdout.push(Buffer.from(chunk)));
    child.stderr?.on('data', (chunk: Buffer | string) => stderr.push(Buffer.from(chunk)));
    child.on('error', async (err) => {
      const result = { ok: false, stdout: bufferText(stdout), stderr: err.message };
      if (options.logPath) await appendResultLog(options.logPath, result);
      resolve(result);
    });
    child.on('close', async (code) => {
      const result = { ok: code === 0, stdout: bufferText(stdout), stderr: bufferText(stderr) };
      if (options.logPath) await appendResultLog(options.logPath, result);
      resolve(result);
    });
  });
}

class UpgradeCommandError extends Error {
  constructor(
    readonly stage: string,
    message: string,
  ) {
    super(message || `${stage} failed`);
    this.name = 'UpgradeCommandError';
  }
}

function defaultOperationId(): string {
  return `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
}

function assertSafeGitName(value: string, label: string): void {
  if (
    !value ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.includes('..') ||
    value.includes('@{') ||
    /[\s:\\]/.test(value)
  ) {
    throw new Error(`invalid upgrade ${label}: ${value}`);
  }
}

function bufferText(chunks: readonly Buffer[]): string {
  return Buffer.concat(chunks).toString('utf8');
}

async function appendCommandLog(logPath: string, command: string, args: readonly string[], cwd?: string): Promise<void> {
  await mkdir(dirname(logPath), { recursive: true });
  await appendFile(logPath, `$ ${[command, ...args].join(' ')}${cwd ? `\n# cwd: ${cwd}` : ''}\n`, {
    mode: 0o600,
  });
}

async function appendResultLog(logPath: string, result: UpgradeCommandResult): Promise<void> {
  const parts = [];
  if (result.stdout) parts.push(result.stdout);
  if (result.stderr) parts.push(result.stderr);
  if (parts.length) await appendFile(logPath, `${parts.join('')}\n`, { mode: 0o600 });
}
