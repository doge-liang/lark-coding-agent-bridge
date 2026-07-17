import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { NormalizedMessage } from '@larksuite/channel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { tryHandleCommand, type CommandContext, type Controls } from '../../../src/commands/index';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { getSecret, listSecretIds } from '../../../src/config/keystore';
import {
  createDefaultProfileConfig,
  type RootConfig,
} from '../../../src/config/profile-schema';
import { runtimeProfileConfig } from '../../../src/config/profile-store';
import { getRequireMentionInGroup, secretKeyForApp } from '../../../src/config/schema';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { createFakeChannel } from '../../helpers/fake-channel';

vi.mock('../../../src/utils/feishu-auth', () => ({
  validateAppCredentials: vi.fn(async () => ({
    ok: true,
    botName: 'Updated Bot',
    botOpenId: 'ou-bot',
  })),
}));

const identityPolicyMocks = vi.hoisted(() => ({
  applyLarkCliIdentityPolicy: vi.fn(async () => true),
}));

vi.mock('../../../src/lark-cli/identity-policy', async () => {
  const actual = await vi.importActual<typeof import('../../../src/lark-cli/identity-policy')>(
    '../../../src/lark-cli/identity-policy',
  );
  return {
    ...actual,
    applyLarkCliIdentityPolicy: identityPolicyMocks.applyLarkCliIdentityPolicy,
  };
});

const roots: string[] = [];

beforeEach(() => {
  identityPolicyMocks.applyLarkCliIdentityPolicy.mockReset();
  identityPolicyMocks.applyLarkCliIdentityPolicy.mockResolvedValue(true);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('profile-aware account and config commands', () => {
  it('opens the Codex profile form through the Feishu menu shortcut text', async () => {
    const h = await createHarness({ activeProfile: 'codex-dev' });

    await h.command('Codex 设置');

    const card = lastContent(h);
    expect(card).toContain('Codex profile 设置');
    expect(card).toContain('default_access');
    expect(card).toContain('max_access');
    expect(card).toContain('model');
    expect(card).toContain('model_reasoning_effort');
    expect(card).toContain('codex_home_mode');
    expect(card).toContain('ignore_user_config');
    expect(card).toContain('ignore_rules');
  });

  it('opens the Claude profile form with a model field', async () => {
    const h = await createHarness({ activeProfile: 'claude' });

    await h.command('/config');

    const card = lastContent(h);
    expect(card).toContain('claude_model');
    expect(card).toContain('Claude Code 模型');
    expect(card).toContain('upgrade_source_url');
    expect(card).toContain('升级源 URL');
  });

  it('saves /codex-config submit into the active Codex profile', async () => {
    vi.useFakeTimers();
    const h = await createHarness({ activeProfile: 'codex-dev' });
    const nextWorkspace = join(h.rootDir, 'next-workspace');
    const customCodexHome = join(h.rootDir, 'custom-codex-home');
    await mkdir(nextWorkspace, { recursive: true });
    await mkdir(customCodexHome, { recursive: true });
    await writeFile(
      join(customCodexHome, 'config.toml'),
      '[features]\nshell_snapshot = true\n',
      'utf8',
    );

    await h.command('/codex-config submit', {
      default_workspace: nextWorkspace,
      default_access: 'workspace',
      max_access: 'full',
      model: 'gpt-5.5',
      model_reasoning_effort: 'xhigh',
      codex_home_mode: 'custom',
      codex_home_path: customCodexHome,
      ignore_user_config: 'yes',
      ignore_rules: 'no',
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1000);

    const root = await waitForRoot(h.rootDir, (candidate) =>
      candidate.profiles['codex-dev']?.codex?.codexHome === customCodexHome,
    );
    const profile = root.profiles['codex-dev'];
    expect(profile?.workspaces.default).toBe(nextWorkspace);
    expect(profile?.permissions).toEqual({
      defaultAccess: 'workspace',
      maxAccess: 'full',
    });
    expect(profile?.codex).toMatchObject({
      binaryPath: 'codex',
      codexHome: customCodexHome,
      inheritCodexHome: false,
      ignoreUserConfig: true,
      ignoreRules: false,
    });
    const codexConfig = await readFile(join(customCodexHome, 'config.toml'), 'utf8');
    expect(codexConfig).toMatch(/^model = "gpt-5\.5"$/m);
    expect(codexConfig).toMatch(/^model_reasoning_effort = "xhigh"$/m);
    expect(codexConfig).toContain('[features]\nshell_snapshot = true');
    expect(root.profiles.claude?.workspaces.default).not.toBe(nextWorkspace);
    const card = lastContent(h);
    expect(card).toContain('Codex 设置已保存');
    expect(card).toContain('gpt-5.5');
    expect(card).toContain('xhigh');
    expect(card).toContain('需要重启当前 profile');
  });

  it('rejects /codex-config on a non-Codex profile', async () => {
    const h = await createHarness({ activeProfile: 'claude' });

    await h.command('/codex-config');

    const message = lastContent(h);
    expect(message).toContain('当前 profile 不是 Codex');
  });

  it('saves /config submit into the active v2 profile without flattening root config', async () => {
    vi.useFakeTimers();
    const h = await createHarness();

    await h.command('/config submit', {
      message_reply: 'text',
      show_tool_calls: 'hide',
      max_concurrent_runs: '7',
      run_idle_timeout_minutes: '15',
      require_mention_in_group: 'no',
      lark_cli_identity: 'user-default',
      upgrade_enabled: 'yes',
      upgrade_source_url: 'https://github.com/example/lark-channel-bridge.git',
      claude_model: 'sonnet',
    });

    const root = await waitForRoot(h.rootDir, (candidate) =>
      candidate.profiles.claude?.preferences.messageReply === 'text' &&
      candidate.profiles.claude?.upgrade.enabled === true &&
      claudeModel(candidate.profiles.claude) === 'sonnet',
    );
    expect(root.schemaVersion).toBe(2);
    expect(root.activeProfile).toBe('claude');
    expect(root.profiles['codex-dev']).toBeDefined();
    expect(root.profiles.claude?.preferences).toMatchObject({
      messageReply: 'text',
      messageReplyMigrated: true,
      showToolCalls: false,
      maxConcurrentRuns: 7,
      runIdleTimeoutMinutes: 15,
    });
    expect(root.profiles.claude?.access.requireMentionInGroup).toBe(false);
    expect(root.profiles.claude?.larkCli.identityPreset).toBe('user-default');
    expect(root.profiles.claude?.upgrade).toMatchObject({
      enabled: true,
      remote: 'origin',
      sourceUrl: 'https://github.com/example/lark-channel-bridge.git',
      branch: 'main',
      requireTests: false,
      healthTimeoutMs: 60_000,
      retainReleases: 3,
    });
    expect(claudeModel(root.profiles.claude)).toBe('sonnet');
    expect(root.profiles['codex-dev']?.upgrade.enabled).toBe(false);
    expect(root.profiles.claude?.larkCli.localUserImport).toMatchObject({
      status: 'not-needed',
      reason: 'manual-user-default',
    });
    expect(getRequireMentionInGroup(runtimeProfileConfig(root, 'claude'))).toBe(false);
    expect((root as unknown as { accounts?: unknown }).accounts).toBeUndefined();
  });

  it('keeps the existing Claude model when an old /config card submits no model field', async () => {
    vi.useFakeTimers();
    const h = await createHarness({ claudeModel: 'opus' });

    await h.command('/config submit', {
      message_reply: 'text',
      show_tool_calls: 'hide',
      max_concurrent_runs: '7',
      run_idle_timeout_minutes: '15',
      require_mention_in_group: 'no',
      lark_cli_identity: 'bot-only',
      upgrade_enabled: 'yes',
    });

    const root = await waitForRoot(h.rootDir, (candidate) =>
      candidate.profiles.claude?.preferences.messageReply === 'text',
    );
    expect(claudeModel(root.profiles.claude)).toBe('opus');
  });

  it('does not save a lark-cli identity change when applying the runtime policy fails', async () => {
    vi.useFakeTimers();
    identityPolicyMocks.applyLarkCliIdentityPolicy.mockResolvedValueOnce(false);
    const h = await createHarness();

    await h.command('/config submit', {
      message_reply: 'text',
      show_tool_calls: 'hide',
      max_concurrent_runs: '7',
      run_idle_timeout_minutes: '15',
      require_mention_in_group: 'no',
      lark_cli_identity: 'user-default',
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => {
      expect(h.channel.sent.length).toBeGreaterThan(0);
    });

    const root = await readRoot(h.rootDir);
    expect(root.profiles.claude?.larkCli.identityPreset).toBe('bot-only');
    expect(root.profiles.claude?.preferences.messageReply).not.toBe('text');
    expect(appliedLarkCliIdentities()).toEqual([
      'user-default',
      'bot-only',
    ]);
    const card = JSON.stringify(h.channel.sent.at(-1)?.content);
    expect(card).toContain('保存失败');
    expect(card).toContain('lark-cli 身份策略');
    expect(card).not.toContain('偏好已保存');
  });

  it('rolls back lark-cli identity when saving config fails after applying the runtime policy', async () => {
    vi.useFakeTimers();
    const applied = deferred<boolean>();
    identityPolicyMocks.applyLarkCliIdentityPolicy
      .mockImplementationOnce(async () => applied.promise)
      .mockResolvedValue(true);
    const h = await createHarness();

    await h.command('/config submit', {
      message_reply: 'text',
      show_tool_calls: 'hide',
      max_concurrent_runs: '7',
      run_idle_timeout_minutes: '15',
      require_mention_in_group: 'no',
      lark_cli_identity: 'user-default',
    });
    await Promise.resolve();
    await writeFile(resolveAppPaths({ rootDir: h.rootDir }).configFile, '{invalid json', 'utf8');
    applied.resolve(true);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => {
      expect(h.channel.sent.length).toBeGreaterThan(0);
    });

    expect(appliedLarkCliIdentities()).toEqual([
      'user-default',
      'bot-only',
    ]);
    const card = JSON.stringify(h.channel.sent.at(-1)?.content);
    expect(card).toContain('保存失败');
    expect(card).toContain('已回滚');
    expect(card).not.toContain('未做任何修改');
    expect(card).not.toContain('偏好已保存');
  });

  it('saves /account submit into the active v2 profile and profile-local keystore', async () => {
    vi.useFakeTimers();
    const h = await createHarness();

    await h.command('/account submit', {
      app_id: 'cli_new',
      app_secret: 'new-secret',
      tenant: 'lark',
    });

    const root = await waitForRoot(h.rootDir, (candidate) =>
      candidate.profiles.claude?.accounts.app.id === 'cli_new',
    );
    expect(root.schemaVersion).toBe(2);
    expect(root.profiles['codex-dev']).toBeDefined();
    expect(root.profiles.claude?.accounts.app).toMatchObject({
      id: 'cli_new',
      tenant: 'lark',
      secret: {
        source: 'exec',
        provider: 'bridge',
        id: secretKeyForApp('cli_new'),
      },
    });
    expect(root.secrets?.providers?.bridge?.command).toContain('secrets-getter');
    expect((root as unknown as { accounts?: unknown }).accounts).toBeUndefined();
    await expect(
      getSecret(secretKeyForApp('cli_new'), resolveAppPaths({ rootDir: h.rootDir, profile: 'claude' })),
    ).resolves.toBe('new-secret');
    const claudePaths = resolveAppPaths({ rootDir: h.rootDir, profile: 'claude' });
    const codexPaths = resolveAppPaths({ rootDir: h.rootDir, profile: 'codex-dev' });
    expect(claudePaths.secretsFile).not.toBe(codexPaths.secretsFile);
    await expect(
      listSecretIds(codexPaths),
    ).resolves.not.toContain(secretKeyForApp('cli_new'));
  });
});

async function createHarness(
  opts: { activeProfile?: 'claude' | 'codex-dev'; claudeModel?: string } = {},
): Promise<{
  rootDir: string;
  channel: ReturnType<typeof createFakeChannel>;
  command(content: string, formValue?: Record<string, unknown>): Promise<boolean>;
}> {
  const activeProfile = opts.activeProfile ?? 'claude';
  const rootDir = await mkdtemp(join(tmpdir(), 'bridge-profile-config-command-'));
  roots.push(rootDir);
  const workspace = join(rootDir, 'workspace');
  await mkdir(workspace, { recursive: true });
  const root = await writeRoot(rootDir, workspace, activeProfile, opts.claudeModel);
  const profileConfig = root.profiles[activeProfile]!;
  const appPaths = resolveAppPaths({ rootDir, profile: activeProfile });
  const channel = createFakeChannel();
  const sessions = new SessionStore(appPaths.sessionsFile);
  const workspaces = new WorkspaceStore(appPaths.workspacesFile);
  const controls = {
    profile: activeProfile,
    profileConfig,
    botOwnerId: 'ou-admin',
    ownerRefreshState: 'ok',
    async refreshOwner() {},
    restart: vi.fn(async () => {}),
    exit: vi.fn(async () => {}),
    configPath: appPaths.configFile,
    cfg: runtimeProfileConfig(root, activeProfile),
    processId: 'proc-1',
  } satisfies Controls;

  return {
    rootDir,
    channel,
    command: (content: string, formValue?: Record<string, unknown>) =>
      tryHandleCommand({
        channel: channel as unknown as CommandContext['channel'],
        msg: message(content),
        scope: 'chat-1',
        chatMode: 'p2p',
        sessions,
        workspaces,
        agent: new FakeAgentAdapter(),
        activeRuns: new ActiveRuns(),
        controls,
        formValue,
        fromCardAction: Boolean(formValue),
      }),
  };
}

async function writeRoot(
  rootDir: string,
  workspace: string,
  activeProfile: 'claude' | 'codex-dev' = 'claude',
  claudeModel?: string,
): Promise<RootConfig> {
  const root: RootConfig = {
    schemaVersion: 2,
    activeProfile,
    preferences: {},
    profiles: {
      claude: createDefaultProfileConfig({
        agentKind: 'claude',
        accounts: {
          app: { id: 'cli_old', secret: '${APP_SECRET}', tenant: 'feishu' },
        },
        access: { admins: ['ou-admin'] },
      }),
      'codex-dev': createDefaultProfileConfig({
        agentKind: 'codex',
        accounts: {
          app: { id: 'cli_codex', secret: '${APP_SECRET}', tenant: 'feishu' },
        },
        codex: { binaryPath: 'codex' },
        access: { admins: ['ou-admin'] },
      }),
    },
  };
  if (claudeModel) {
    (root.profiles.claude as unknown as { claude?: { model: string } }).claude = {
      model: claudeModel,
    };
  }
  root.profiles.claude!.workspaces.default = workspace;
  root.profiles['codex-dev']!.workspaces.default = workspace;
  await writeJson(resolveAppPaths({ rootDir }).configFile, root);
  await writeFile(join(rootDir, 'active-profile'), `${activeProfile}\n`, 'utf8');
  return root;
}

async function readRoot(rootDir: string): Promise<RootConfig> {
  return JSON.parse(await readFile(resolveAppPaths({ rootDir }).configFile, 'utf8')) as RootConfig;
}

async function waitForRoot(
  rootDir: string,
  predicate: (root: RootConfig) => boolean,
): Promise<RootConfig> {
  let lastRoot = await readRoot(rootDir);
  await vi.waitFor(async () => {
    lastRoot = await readRoot(rootDir);
    expect(predicate(lastRoot)).toBe(true);
  }, { timeout: 5000 });
  return lastRoot;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function appliedLarkCliIdentities(): unknown[] {
  return (
    identityPolicyMocks.applyLarkCliIdentityPolicy.mock.calls as unknown as Array<[unknown, unknown]>
  ).map((call) => call[1]);
}

function claudeModel(profile: unknown): string | undefined {
  return (profile as { claude?: { model?: string } } | undefined)?.claude?.model;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function lastContent(h: { channel: ReturnType<typeof createFakeChannel> }): string {
  return JSON.stringify(h.channel.sent.at(-1)?.content ?? '');
}

function message(content: string): NormalizedMessage {
  return {
    messageId: `om-${content.replace(/\W+/g, '-').slice(0, 20)}`,
    chatId: 'chat-1',
    chatType: 'p2p',
    senderId: 'ou-admin',
    senderName: 'Admin',
    content,
    resources: [],
    mentionedBot: false,
  } as unknown as NormalizedMessage;
}
