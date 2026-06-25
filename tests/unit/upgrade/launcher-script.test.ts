import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildUpgradeLauncherScript, writeUpgradeLauncherScript } from '../../../src/upgrade/launcher-script';

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
    expect(script).toContain('pendingNotification');
    expect(script).toContain("id: pending.operationId + ':activation_failed'");
    expect(script).toContain('rollbackState');
  });

  it('retries after timeout only when rollback switches to a previous release', () => {
    const script = buildUpgradeLauncherScript({
      profile: 'codex-dev',
      channelHome: '/tmp/lark-home',
      fallbackNodePath: '/usr/bin/node',
      fallbackBridgeEntryPath: '/repo/bin/lark-channel-bridge.mjs',
    });

    expect(script).toContain('rolledBackForTimeout');
    expect(script).toContain(
      "rolledBackForTimeout = rollbackState(latest, 'health-timeout').rolledBack === true;",
    );
    expect(script).toContain("if (rolledBackForTimeout) return 'retry';");
  });

  it('checks matching pending activation before timeout rollback', () => {
    const script = buildUpgradeLauncherScript({
      profile: 'codex-dev',
      channelHome: '/tmp/lark-home',
      fallbackNodePath: '/usr/bin/node',
      fallbackBridgeEntryPath: '/repo/bin/lark-channel-bridge.mjs',
    });

    expect(script).toContain('const latest = readState();');
    expect(script).toContain('!latest.pendingActivation');
    expect(script).toContain('latest.pendingActivation.commit !== pendingActivation.commit');
    expect(script).toContain('latest.pendingActivation.operationId !== pendingActivation.operationId');
    expect(script).toContain('return;');
  });

  it('retries after early child exit only when rollback switches to a previous release', () => {
    const script = buildUpgradeLauncherScript({
      profile: 'codex-dev',
      channelHome: '/tmp/lark-home',
      fallbackNodePath: '/usr/bin/node',
      fallbackBridgeEntryPath: '/repo/bin/lark-channel-bridge.mjs',
    });

    expect(script).toContain('const rollbackResult = rollbackState(latest, childExitMessage(childResult, stderrTail));');
    expect(script).toContain("if (rollbackResult.rolledBack) return 'retry';");
    expect(script).toContain('process.exit(1);');
  });

  it('includes child exit details and stderr tail in activation rollback reason', () => {
    const script = buildUpgradeLauncherScript({
      profile: 'codex-dev',
      channelHome: '/tmp/lark-home',
      fallbackNodePath: '/usr/bin/node',
      fallbackBridgeEntryPath: '/repo/bin/lark-channel-bridge.mjs',
    });

    expect(script).toContain('function childExitMessage(result, stderrTail)');
    expect(script).toContain("parts.push('exitCode=' + result.exitCode)");
    expect(script).toContain("parts.push('signal=' + result.signal)");
    expect(script).toContain("parts.push('stderr=' + sanitizeDiagnostic(stderrTail))");
    expect(script).toContain('const childResult = await waitForChildExit(child);');
    expect(script).toContain('const rollbackResult = rollbackState(latest, childExitMessage(childResult, stderrTail));');
  });

  it('does not roll back pending activation when the launcher is stopped by the service manager', async () => {
    const root = await mkdtemp(join(tmpdir(), 'upgrade-launcher-sigterm-'));
    try {
      const profile = 'codex-dev';
      const upgradeRoot = join(root, 'profiles', profile, 'upgrades');
      const releasePath = join(upgradeRoot, 'releases', 'new');
      const stateFile = join(upgradeRoot, 'state.json');
      const childReadyFile = join(root, 'child-ready');
      const launcherFile = join(upgradeRoot, 'launcher.mjs');
      await mkdir(join(releasePath, 'bin'), { recursive: true });
      await writeFile(
        join(releasePath, 'bin', 'lark-channel-bridge.mjs'),
        `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(childReadyFile)}, 'ready');
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`,
        { mode: 0o700 },
      );
      await writeFile(
        stateFile,
        JSON.stringify(
          {
            current: { commit: 'new', path: releasePath },
            pendingActivation: {
              commit: 'new',
              operationId: 'op-1',
              startedAt: new Date().toISOString(),
              deadlineAt: new Date(Date.now() + 30_000).toISOString(),
            },
          },
          null,
          2,
        ) + '\n',
        { mode: 0o600 },
      );
      await writeUpgradeLauncherScript(launcherFile, {
        profile,
        channelHome: root,
        fallbackNodePath: process.execPath,
        fallbackBridgeEntryPath: '/fallback/bridge.mjs',
      });

      const launcher = spawn(process.execPath, [launcherFile], {
        env: { ...process.env, LARK_CHANNEL_HOME: root },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      launcher.stderr?.on('data', (chunk) => {
        stderr += String(chunk);
      });
      await waitForFile(childReadyFile, launcher, () => stderr);

      launcher.kill('SIGTERM');
      const result = await waitForExit(launcher);
      expect(result).toEqual({ code: 0, signal: null });

      const state = JSON.parse(await readFile(stateFile, 'utf8')) as {
        current?: { commit?: string };
        pendingActivation?: { commit?: string };
        lastOperation?: { status?: string; stage?: string };
      };
      expect(state.current?.commit).toBe('new');
      expect(state.pendingActivation?.commit).toBe('new');
      expect(state.lastOperation).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000);

  it('does not roll back when another activation process owns the profile lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'upgrade-launcher-lock-owner-'));
    try {
      const profile = 'codex-dev';
      const upgradeRoot = join(root, 'profiles', profile, 'upgrades');
      const newReleasePath = join(upgradeRoot, 'releases', 'new');
      const oldReleasePath = join(upgradeRoot, 'releases', 'old');
      const stateFile = join(upgradeRoot, 'state.json');
      const launcherFile = join(upgradeRoot, 'launcher.mjs');
      const pendingStartedAt = '2026-06-25T12:19:20.000Z';
      await mkdir(join(newReleasePath, 'bin'), { recursive: true });
      await mkdir(join(oldReleasePath, 'bin'), { recursive: true });
      await writeFile(
        join(newReleasePath, 'bin', 'lark-channel-bridge.mjs'),
        `#!/usr/bin/env node
console.error('runtime profile lock is already held by another activating bridge');
process.exit(1);
`,
        { mode: 0o700 },
      );
      await writeFile(
        join(oldReleasePath, 'bin', 'lark-channel-bridge.mjs'),
        `#!/usr/bin/env node
process.exit(0);
`,
        { mode: 0o700 },
      );
      await writeFile(
        stateFile,
        JSON.stringify(
          {
            current: { commit: 'new', path: newReleasePath },
            previous: { commit: 'old', path: oldReleasePath },
            pendingActivation: {
              commit: 'new',
              operationId: 'op-1',
              startedAt: pendingStartedAt,
              deadlineAt: new Date(Date.now() + 30_000).toISOString(),
            },
          },
          null,
          2,
        ) + '\n',
        { mode: 0o600 },
      );
      const profileLock = join(root, 'registry', 'locks', 'profile', `${profile}.lock`);
      await mkdir(join(root, 'registry', 'locks', 'profile'), { recursive: true });
      await writeFile(profileLock, '', { mode: 0o600 });
      await writeFile(
        `${profileLock}.meta.json`,
        JSON.stringify(
          {
            kind: 'profile',
            target: profileLock,
            profile,
            agentKind: 'codex',
            pid: process.pid,
            startedAt: '2026-06-25T12:19:24.000Z',
          },
          null,
          2,
        ) + '\n',
        { mode: 0o600 },
      );
      await writeUpgradeLauncherScript(launcherFile, {
        profile,
        channelHome: root,
        fallbackNodePath: process.execPath,
        fallbackBridgeEntryPath: '/fallback/bridge.mjs',
      });

      const launcher = spawn(process.execPath, [launcherFile], {
        env: { ...process.env, LARK_CHANNEL_HOME: root },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const result = await waitForExit(launcher);
      expect(result).toEqual({ code: 0, signal: null });

      const state = JSON.parse(await readFile(stateFile, 'utf8')) as {
        current?: { commit?: string };
        pendingActivation?: { commit?: string };
        lastOperation?: { status?: string; stage?: string };
      };
      expect(state.current?.commit).toBe('new');
      expect(state.pendingActivation?.commit).toBe('new');
      expect(state.lastOperation).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000);
});

async function waitForFile(
  path: string,
  child: ReturnType<typeof spawn>,
  stderr: () => string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      await access(path);
      return;
    } catch (err) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`launcher exited before child was ready: ${stderr().trim()}`);
      }
      if (Date.now() >= deadline) throw err;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}
