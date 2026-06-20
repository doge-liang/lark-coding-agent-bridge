import { realpathSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CommandContext } from '../commands';
import { resolveAppPaths } from '../config/app-paths';
import { getServiceAdapter } from '../daemon/service-adapter';
import {
  UpgradeManager,
  type UpgradeApplyResult,
  type UpgradeCheckResult,
  type UpgradeRollbackResult,
  type UpgradeStatus,
} from './manager';

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
    restartService: () =>
      adapter ? adapter.restart() : { ok: false, stderr: '当前系统不支持后台 service restart' },
  });
  return {
    status: async () => formatStatus(await manager.status()),
    check: async () => formatCheck(await manager.check()),
    apply: async () => formatApply(await manager.apply()),
    rollback: async () => formatRollback(await manager.rollback()),
  };
}

function currentBridgeRoot(): string {
  const entryPath = process.argv[1] ? realpathIfPresent(process.argv[1]) : fileURLToPath(import.meta.url);
  return resolveBridgeRootFromEntry(entryPath);
}

export function resolveBridgeRootFromEntry(entryPath: string): string {
  const entryDir = dirname(entryPath);
  const parent = basename(entryDir);
  const grandparent = basename(dirname(entryDir));

  if (parent === 'bin' || parent === 'dist') return dirname(entryDir);
  if (grandparent === 'src') return dirname(dirname(entryDir));
  return entryDir;
}

function realpathIfPresent(entryPath: string): string {
  try {
    return realpathSync(entryPath);
  } catch {
    return entryPath;
  }
}

function formatStatus(result: UpgradeStatus): string {
  if (!result.enabled) return '升级未启用。';
  const lines = [
    `当前版本: ${formatCommit(result.state.current?.commit)}`,
    `跟踪分支: \`${result.remote}/${result.branch}\``,
    `运行测试: ${result.requireTests ? '是' : '否'}`,
  ];
  if (result.state.previous?.commit) lines.push(`可回滚到: ${formatCommit(result.state.previous.commit)}`);
  if (result.state.pendingActivation) {
    lines.push(`等待健康确认: ${formatCommit(result.state.pendingActivation.commit)}`);
  }
  if (result.state.lastOperation) {
    lines.push(
      `最近操作: ${result.state.lastOperation.kind}/${result.state.lastOperation.status} (${result.state.lastOperation.stage})`,
    );
  }
  return lines.join('\n');
}

function formatCheck(result: UpgradeCheckResult): string {
  switch (result.status) {
    case 'disabled':
      return '升级未启用。';
    case 'current':
      return `已是最新: ${formatCommit(result.targetCommit)}。`;
    case 'update':
      return [
        `可升级到 ${formatCommit(result.targetCommit)}。`,
        result.title ? `标题: ${result.title}` : undefined,
        result.author ? `作者: ${result.author}` : undefined,
        result.committedAt ? `提交时间: ${result.committedAt}` : undefined,
      ].filter(Boolean).join('\n');
    case 'failed':
      return `检查升级失败 (${result.stage ?? 'check'}): ${result.message ?? '未知错误'}`;
  }
}

function formatApply(result: UpgradeApplyResult): string {
  switch (result.status) {
    case 'disabled':
      return '升级未启用。';
    case 'ok':
      return `已切换到 ${formatCommit(result.targetCommit)}，正在重启。`;
    case 'restart_failed':
      return [
        `已切换到 ${formatCommit(result.targetCommit)}，但重启失败。`,
        `错误: ${result.stderr || '未知错误'}`,
        `日志: \`${result.logPath}\``,
      ].join('\n');
    case 'current':
      return `已是最新: ${formatCommit(result.targetCommit)}。`;
    case 'failed':
      return [
        `升级失败 (${result.stage}): ${result.message}`,
        `日志: \`${result.logPath}\``,
      ].join('\n');
  }
}

function formatRollback(result: UpgradeRollbackResult): string {
  switch (result.status) {
    case 'disabled':
      return '升级未启用。';
    case 'ok':
      return `已切回 ${formatCommit(result.currentCommit)}，正在重启。`;
    case 'restart_failed':
      return [
        `已切回 ${formatCommit(result.currentCommit)}，但重启失败。`,
        `错误: ${result.stderr || '未知错误'}`,
      ].join('\n');
    case 'failed':
      return `回滚失败 (${result.stage}): ${result.message}`;
  }
}

function formatCommit(commit?: string): string {
  return commit ? `\`${commit.slice(0, 12)}\`` : '`unknown`';
}
