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
