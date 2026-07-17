import { describe, expect, it } from 'vitest';
import {
  accessToClaudePermissionMode,
  clampAccess,
} from '../../../src/config/permissions';
import {
  createDefaultProfileConfig,
  normalizeProfileConfig,
} from '../../../src/config/profile-schema';
import {
  createRootConfig,
  formatRootConfig,
} from '../../../src/config/profile-store';

const app = {
  id: 'cli_test',
  secret: '${APP_SECRET}',
  tenant: 'feishu' as const,
};

describe('profile schema', () => {
  it('defaults Claude sandbox to danger-full-access through canonical permissions', () => {
    const cfg = createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: { app },
    });

    expect(cfg.schemaVersion).toBe(2);
    expect(cfg.agentKind).toBe('claude');
    expect(cfg.permissions).toMatchObject({
      defaultAccess: 'full',
      maxAccess: 'full',
    });
    expect(cfg.sandbox).toMatchObject({
      default: 'danger-full-access',
      max: 'danger-full-access',
      defaultMode: 'danger-full-access',
      maxMode: 'danger-full-access',
    });
  });

  it('defaults Codex sandbox to danger-full-access to match Claude bridge local tool access', () => {
    const cfg = createDefaultProfileConfig({
      agentKind: 'codex',
      accounts: { app },
      codex: { binaryPath: '/usr/local/bin/codex' },
    });

    expect(cfg.sandbox).toMatchObject({
      default: 'danger-full-access',
      max: 'danger-full-access',
      defaultMode: 'danger-full-access',
      maxMode: 'danger-full-access',
    });
  });

  it('requires codex configuration when agentKind is codex', () => {
    expect(() =>
      normalizeProfileConfig({
        schemaVersion: 2,
        agentKind: 'codex',
        accounts: { app },
      }),
    ).toThrow(/codex/i);
  });

  it('rejects sandbox defaults that exceed max capability as a permission error', () => {
    expect(() =>
      normalizeProfileConfig({
        schemaVersion: 2,
        agentKind: 'claude',
        accounts: { app },
        sandbox: {
          defaultMode: 'workspace-write',
          maxMode: 'read-only',
        },
      }),
    ).toThrow(/permission/i);
  });

  it('keeps access at profile top level without legacy open semantics', () => {
    const cfg = normalizeProfileConfig({
      schemaVersion: 2,
      agentKind: 'claude',
      accounts: { app },
      preferences: {
        messageReply: 'markdown',
      },
      access: {
        allowedUsers: [],
        allowedChats: [],
        admins: [],
      },
    });

    expect(cfg.preferences).not.toHaveProperty('access');
    expect(JSON.stringify(cfg)).not.toMatch(/access\.semantics|legacy-open|explicit/);
    expect(cfg.access).toEqual({
      allowedUsers: [],
      allowedChats: [],
      admins: [],
      requireMentionInGroup: true,
    });
  });

  it('drops invalid legacy message reply values instead of blocking config load', () => {
    const cfg = normalizeProfileConfig({
      schemaVersion: 2,
      agentKind: 'claude',
      accounts: { app },
      preferences: {
        messageReply: 'plain-text',
        showToolCalls: false,
      } as never,
    });

    expect(cfg.preferences).toEqual({
      showToolCalls: false,
    });
  });

  it('normalizes workspaces to a default working directory only', () => {
    const cfg = createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: { app },
    });

    expect(cfg.workspaces).toEqual({});
  });

  it('defaults lark-cli identity to app-only without legacy global source fields', () => {
    const cfg = createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: { app },
    });

    expect(cfg.larkCli).toEqual({ identityPreset: 'bot-only' });
    expect(cfg.larkCli).not.toHaveProperty('configSource');
    expect(cfg.larkCli).not.toHaveProperty('workspaceMode');
  });

  it('defaults controlled self-update to main branch with fast verification', () => {
    const cfg = createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: { app },
    });

    expect(cfg.upgrade).toEqual({
      enabled: false,
      remote: 'origin',
      branch: 'main',
      requireTests: false,
      healthTimeoutMs: 60_000,
      retainReleases: 3,
    });
  });

  it('falls back to main when the configured upgrade branch is blank', () => {
    const cfg = normalizeProfileConfig({
      schemaVersion: 2,
      agentKind: 'claude',
      accounts: { app },
      upgrade: {
        branch: '   ',
      },
    });

    expect(cfg.upgrade.branch).toBe('main');
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

  it('normalizes and serializes Claude environment overrides', () => {
    const cfg = normalizeProfileConfig({
      schemaVersion: 2,
      agentKind: 'claude',
      accounts: { app },
      claude: {
        model: 'opus',
        env: {
          IS_SANDBOX: '1',
          EMPTY: '',
          NUMBER: 1,
        },
      },
    });

    expect(cfg.claude).toEqual({
      model: 'opus',
      env: {
        IS_SANDBOX: '1',
        NUMBER: '1',
      },
    });

    const text = formatRootConfig(createRootConfig('claude', cfg));
    expect(JSON.parse(text).profiles.claude.claude).toEqual(cfg.claude);
  });

  it('normalizes lark-cli user identity import state without preserving invalid fields', () => {
    const cfg = normalizeProfileConfig({
      schemaVersion: 2,
      agentKind: 'claude',
      accounts: { app },
      larkCli: {
        identityPreset: 'user-default',
        configSource: 'legacy-global',
        workspaceMode: 'shared',
        localUserImport: {
          status: 'imported',
          attemptedAt: '2026-06-04T01:02:03.000Z',
          importedAt: '2026-06-04T01:03:03.000Z',
          reason: 'same-app-local-user',
          token: 'must-not-survive',
        },
      },
    });

    expect(cfg.larkCli).toEqual({
      identityPreset: 'user-default',
      localUserImport: {
        status: 'imported',
        attemptedAt: '2026-06-04T01:02:03.000Z',
        importedAt: '2026-06-04T01:03:03.000Z',
        reason: 'same-app-local-user',
      },
    });
    expect(JSON.stringify(cfg.larkCli)).not.toContain('legacy-global');
    expect(JSON.stringify(cfg.larkCli)).not.toContain('workspaceMode');
    expect(JSON.stringify(cfg.larkCli)).not.toContain('token');
  });

  it('tolerates legacy workspace root fields without preserving them', () => {
    const cfg = normalizeProfileConfig({
      schemaVersion: 2,
      agentKind: 'claude',
      accounts: { app },
      workspaces: {
        default: '/repo',
        trusted: ['/repo'],
        trustedRoots: ['/repo'],
        defaultWorkspaces: ['/repo'],
        riskFlags: ['legacy-home'],
      },
    });

    expect(cfg.workspaces).toEqual({ default: '/repo' });
  });

  it('drops comment config while tolerating legacy comment fields', () => {
    const cfg = normalizeProfileConfig({
      schemaVersion: 2,
      agentKind: 'claude',
      accounts: { app },
      comments: {
        enabled: false,
        allowUsers: ['ou-user'],
        allowGroups: ['oc-chat'],
        allowlist: {
          docs: ['doc-b', 'doc-a', 'doc-a'],
          wikiSpaces: ['space-a'],
          folders: ['folder-a'],
        },
        bindings: {
          'doc-a': { workspace: '/repo/a', readOnly: true },
        },
        workspace: '/repo/comment',
        rateLimit: {
          perOperatorPerMin: 7,
          perDocPerMin: 13,
        },
      },
    });

    expect(cfg.comments).not.toHaveProperty('enabled');
    expect(cfg.comments).not.toHaveProperty('allowlist');
    expect(cfg.comments).not.toHaveProperty('allowUsers');
    expect(cfg.comments).not.toHaveProperty('allowGroups');
    expect(cfg.comments).not.toHaveProperty('allowedDocuments');
    expect(cfg.comments).not.toHaveProperty('bindings');
    expect(cfg.comments).not.toHaveProperty('workspace');
    expect(cfg.comments).not.toHaveProperty('rateLimit');
    expect(cfg.comments).toEqual({});
  });

  it('does not enable comment rate limits by default', () => {
    const cfg = createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: { app },
    });

    expect(cfg.comments).toEqual({});
  });

  it('seeds attachment limits from the runtime policy', () => {
    const cfg = createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: { app },
    });

    expect(cfg.attachments).toMatchObject({
      maxCount: 10,
      maxBytes: 100 * 1024 * 1024,
      maxFileBytes: 25 * 1024 * 1024,
      imageMaxBytes: 25 * 1024 * 1024,
    });
  });

  it('keeps legacy Codex binary metadata and user-home defaults without keeping public flags', () => {
    const cfg = normalizeProfileConfig({
      schemaVersion: 2,
      agentKind: 'codex',
      accounts: { app },
      codex: {
        binaryPath: '/usr/local/bin/codex',
        realpath: '/opt/codex/bin/codex',
        version: 'codex 1.2.3',
        sha256: 'abc123',
        owner: 501,
        mode: 0o755,
        flags: ['--sandbox', 'workspace-write'],
      },
    });

    expect(cfg.codex).toMatchObject({
      binaryPath: '/usr/local/bin/codex',
      realpath: '/opt/codex/bin/codex',
      version: 'codex 1.2.3',
      sha256: 'abc123',
      owner: 501,
      mode: 0o755,
      inheritCodexHome: true,
      ignoreUserConfig: false,
      ignoreRules: true,
    });
    expect(cfg.codex).not.toHaveProperty('flags');
  });

  it('preserves explicit Codex home isolation when configured', () => {
    const cfg = normalizeProfileConfig({
      schemaVersion: 2,
      agentKind: 'codex',
      accounts: { app },
      codex: {
        binaryPath: '/usr/local/bin/codex',
        inheritCodexHome: false,
      },
    });

    expect(cfg.codex?.inheritCodexHome).toBe(false);
  });

  it('defaults Claude permissions to full/full and derives legacy sandbox for runtime compatibility', () => {
    const cfg = createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: { app },
    });

    expect(cfg.permissions).toMatchObject({
      defaultAccess: 'full',
      maxAccess: 'full',
    });
    expect(cfg.sandbox).toMatchObject({
      default: 'danger-full-access',
      max: 'danger-full-access',
      defaultMode: 'danger-full-access',
      maxMode: 'danger-full-access',
    });
  });

  it('defaults Codex permissions to full/full and derives danger-full-access for Codex runtime', () => {
    const cfg = createDefaultProfileConfig({
      agentKind: 'codex',
      accounts: { app },
      codex: { binaryPath: '/usr/local/bin/codex' },
    });

    expect(cfg.permissions).toMatchObject({
      defaultAccess: 'full',
      maxAccess: 'full',
    });
    expect(cfg.sandbox).toMatchObject({
      default: 'danger-full-access',
      max: 'danger-full-access',
      defaultMode: 'danger-full-access',
      maxMode: 'danger-full-access',
    });
  });

  it('maps legacy sandbox aliases into canonical permissions when permissions are absent', () => {
    const cfg = normalizeProfileConfig({
      schemaVersion: 2,
      agentKind: 'claude',
      accounts: { app },
      sandbox: {
        defaultMode: 'read-only',
        maxMode: 'workspace-write',
      },
    });

    expect(cfg.permissions).toMatchObject({
      defaultAccess: 'read-only',
      maxAccess: 'workspace',
    });
    expect(cfg.sandbox).toMatchObject({
      defaultMode: 'read-only',
      maxMode: 'workspace-write',
    });
  });

  it('lets canonical permissions win over stale legacy sandbox fields', () => {
    const cfg = normalizeProfileConfig({
      schemaVersion: 2,
      agentKind: 'codex',
      accounts: { app },
      codex: { binaryPath: '/usr/local/bin/codex' },
      permissions: {
        defaultAccess: 'workspace',
        maxAccess: 'workspace',
      },
      sandbox: {
        defaultMode: 'danger-full-access',
        maxMode: 'danger-full-access',
      },
    });

    expect(cfg.permissions).toMatchObject({
      defaultAccess: 'workspace',
      maxAccess: 'workspace',
    });
    expect(cfg.sandbox).toMatchObject({
      defaultMode: 'workspace-write',
      maxMode: 'workspace-write',
    });
  });

  it('rejects permission defaults that exceed max access', () => {
    expect(() =>
      normalizeProfileConfig({
        schemaVersion: 2,
        agentKind: 'claude',
        accounts: { app },
        permissions: {
          defaultAccess: 'full',
          maxAccess: 'workspace',
        },
      }),
    ).toThrow(/permission/i);
  });

  it('uses Claude permissionMode override when deriving Claude runtime permissions', () => {
    const cfg = normalizeProfileConfig({
      schemaVersion: 2,
      agentKind: 'claude',
      accounts: { app },
      permissions: {
        defaultAccess: 'full',
        maxAccess: 'full',
        claude: {
          permissionMode: 'default',
        },
      },
    });

    expect(accessToClaudePermissionMode('full', cfg.permissions)).toBe('default');
  });

  it('clamps access by both profile and capability maximums', () => {
    expect(clampAccess('full', 'workspace', 'full')).toBe('workspace');
    expect(clampAccess('workspace', 'full', 'read-only')).toBe('read-only');
    expect(clampAccess('read-only', 'full', 'full')).toBe('read-only');
  });

  it('keeps legacy sandbox access when canonical permissions only set Claude override', () => {
    const cfg = normalizeProfileConfig({
      schemaVersion: 2,
      agentKind: 'claude',
      accounts: { app },
      sandbox: {
        defaultMode: 'read-only',
        maxMode: 'read-only',
      },
      permissions: {
        claude: {
          permissionMode: 'plan',
        },
      },
    });

    expect(cfg.permissions).toMatchObject({
      defaultAccess: 'read-only',
      maxAccess: 'read-only',
      claude: {
        permissionMode: 'plan',
      },
    });
  });

  it('rejects Claude permission overrides wider than max access', () => {
    expect(() =>
      normalizeProfileConfig({
        schemaVersion: 2,
        agentKind: 'claude',
        accounts: { app },
        permissions: {
          maxAccess: 'read-only',
          claude: {
            permissionMode: 'bypassPermissions',
          },
        },
      }),
    ).toThrow(/permission/i);
  });

  it('does not let Claude override exceed the current access at runtime mapping time', () => {
    const cfg = normalizeProfileConfig({
      schemaVersion: 2,
      agentKind: 'claude',
      accounts: { app },
      permissions: {
        defaultAccess: 'read-only',
        maxAccess: 'full',
        claude: {
          permissionMode: 'bypassPermissions',
        },
      },
    });

    expect(accessToClaudePermissionMode('read-only', cfg.permissions)).toBe('plan');
  });

  it('rejects array-shaped permissions config', () => {
    expect(() =>
      normalizeProfileConfig({
        schemaVersion: 2,
        agentKind: 'claude',
        accounts: { app },
        permissions: [],
      }),
    ).toThrow(/permission/i);
  });

  it('rejects array-shaped sandbox config', () => {
    expect(() =>
      normalizeProfileConfig({
        schemaVersion: 2,
        agentKind: 'claude',
        accounts: { app },
        sandbox: [],
      }),
    ).toThrow(/sandbox/i);
  });

  it('rejects array-shaped Claude permissions config', () => {
    expect(() =>
      normalizeProfileConfig({
        schemaVersion: 2,
        agentKind: 'claude',
        accounts: { app },
        permissions: {
          claude: [],
        },
      }),
    ).toThrow(/permission/i);
  });

  it('does not raise legacy default access when only canonical max access is explicit', () => {
    const cfg = normalizeProfileConfig({
      schemaVersion: 2,
      agentKind: 'claude',
      accounts: { app },
      sandbox: {
        defaultMode: 'read-only',
        maxMode: 'danger-full-access',
      },
      permissions: {
        maxAccess: 'workspace',
      },
    });

    expect(cfg.permissions).toMatchObject({
      defaultAccess: 'read-only',
      maxAccess: 'workspace',
    });
  });

  it('clamps default access from full defaults when only canonical max access is explicit', () => {
    const cfg = normalizeProfileConfig({
      schemaVersion: 2,
      agentKind: 'claude',
      accounts: { app },
      permissions: {
        maxAccess: 'workspace',
      },
    });

    expect(cfg.permissions).toMatchObject({
      defaultAccess: 'workspace',
      maxAccess: 'workspace',
    });
  });
});

describe('claude profile config', () => {
  const base = {
    schemaVersion: 2 as const,
    agentKind: 'claude' as const,
    accounts: { app },
  };

  it('accepts claude.env and claude.approvalTimeoutMinutes', () => {
    const cfg = normalizeProfileConfig({
      ...base,
      claude: { env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok' }, approvalTimeoutMinutes: 10 },
    });
    expect(cfg.claude?.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'tok' });
    expect(cfg.claude?.approvalTimeoutMinutes).toBe(10);
  });

  it('omits claude when not configured', () => {
    expect(normalizeProfileConfig(base).claude).toBeUndefined();
  });

  it('rejects invalid env keys and non-positive timeout', () => {
    expect(() =>
      normalizeProfileConfig({ ...base, claude: { env: { 'BAD=KEY': 'x' } } }),
    ).toThrow();
    expect(() =>
      normalizeProfileConfig({ ...base, claude: { approvalTimeoutMinutes: 0 } }),
    ).toThrow();
    expect(() =>
      normalizeProfileConfig({ ...base, claude: { approvalTimeoutMinutes: -1 } }),
    ).toThrow();
  });
});
