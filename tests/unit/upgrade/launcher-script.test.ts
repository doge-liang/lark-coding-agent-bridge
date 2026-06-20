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

  it('retries after timeout only when rollback switches to a previous release', () => {
    const script = buildUpgradeLauncherScript({
      profile: 'codex-dev',
      channelHome: '/tmp/lark-home',
      fallbackNodePath: '/usr/bin/node',
      fallbackBridgeEntryPath: '/repo/bin/lark-channel-bridge.mjs',
    });

    expect(script).toContain('rolledBackForTimeout');
    expect(script).toContain(
      "rolledBackForTimeout = rollbackState(readState(), 'health-timeout').rolledBack === true;",
    );
    expect(script).toContain("if (rolledBackForTimeout) return 'retry';");
  });

  it('retries after early child exit only when rollback switches to a previous release', () => {
    const script = buildUpgradeLauncherScript({
      profile: 'codex-dev',
      channelHome: '/tmp/lark-home',
      fallbackNodePath: '/usr/bin/node',
      fallbackBridgeEntryPath: '/repo/bin/lark-channel-bridge.mjs',
    });

    expect(script).toContain("const rollbackResult = rollbackState(latest, 'child-exited-before-healthy');");
    expect(script).toContain("if (rollbackResult.rolledBack) return 'retry';");
    expect(script).toContain('process.exit(1);');
  });
});
