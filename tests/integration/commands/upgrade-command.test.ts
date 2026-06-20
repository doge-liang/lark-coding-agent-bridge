import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import {
  runCommandHandler,
  tryHandleCommand,
  type CommandContext,
  type Controls,
} from '../../../src/commands/index.js';
import { createDefaultProfileConfig, type ProfileConfig } from '../../../src/config/profile-schema.js';
import { createRootConfig, saveRootConfig } from '../../../src/config/profile-store.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { createFakeAgent } from '../../helpers/fake-agent.js';
import { createFakeChannel, type FakeChannel } from '../../helpers/fake-channel.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

interface RunOverrides {
  scope?: string;
  senderId?: string;
  chatId?: string;
  chatMode?: CommandContext['chatMode'];
}

interface Harness {
  tmp: TmpProfile;
  channel: FakeChannel;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  activeRuns: ActiveRuns;
  agent: ReturnType<typeof createFakeAgent>;
  controls: Controls;
  upgrade: {
    status: ReturnType<typeof vi.fn<() => Promise<string>>>;
    check: ReturnType<typeof vi.fn<() => Promise<string>>>;
    apply: ReturnType<typeof vi.fn<() => Promise<string>>>;
    rollback: ReturnType<typeof vi.fn<() => Promise<string>>>;
  };
  run(content: string, overrides?: RunOverrides): Promise<boolean>;
  runCard(args: string, overrides?: RunOverrides): Promise<boolean>;
}

const cleanups: Array<() => Promise<void>> = [];

describe('Lark upgrade command', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

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

  it('rejects upgrade command callbacks', async () => {
    const h = await createHarness();
    h.upgrade.apply.mockResolvedValue('已切换到 `abc123`，正在重启。');

    await expect(h.runCard('apply')).resolves.toBe(true);

    expect(h.upgrade.apply).not.toHaveBeenCalled();
    expect(lastMarkdown(h.channel)).toContain('文字命令');
  });
});

async function createHarness(): Promise<Harness> {
  const tmp = await createTmpProfile('upgrade-command-');
  const channel = createFakeChannel();
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const activeRuns = new ActiveRuns();
  const agent = createFakeAgent();
  const workspaceRealpath = await realpath(tmp.workspace);
  const profileConfig = appConfig(workspaceRealpath);
  const configPath = join(tmp.root, 'config.json');
  await saveRootConfig(createRootConfig('claude', profileConfig), configPath);
  const controls = {
    profile: 'claude',
    profileConfig,
    botOwnerId: 'ou-owner',
    ownerRefreshState: 'ok',
    ownerRefreshedAt: 1_700_000_000_000,
    async refreshOwner() {},
    restart: vi.fn(async () => {}),
    exit: vi.fn(async () => {}),
    configPath,
    cfg: profileConfig,
    processId: 'proc-1',
  } satisfies Controls;
  const upgrade = {
    status: vi.fn(async () => '当前版本: `abc123`'),
    check: vi.fn(async () => '已是最新。'),
    apply: vi.fn(async () => '已切换，正在重启。'),
    rollback: vi.fn(async () => '已回滚，正在重启。'),
  };

  workspaces.setCwd('chat-1', workspaceRealpath);

  const context = (
    content: string,
    overrides: RunOverrides = {},
    extra: Partial<CommandContext> = {},
  ): CommandContext => {
    const chatId = overrides.chatId ?? 'chat-1';
    const scope = overrides.scope ?? chatId;
    return {
      channel: channel as unknown as CommandContext['channel'],
      msg: message(content, {
        chatId,
        senderId: overrides.senderId ?? 'ou-admin',
      }),
      scope,
      chatMode: overrides.chatMode ?? 'p2p',
      sessions,
      workspaces,
      agent,
      activeRuns,
      controls,
      upgradeCommandService: upgrade,
      ...extra,
    };
  };
  const run = (content: string, overrides: RunOverrides = {}): Promise<boolean> =>
    tryHandleCommand(context(content, overrides));
  const runCard = (args: string, overrides: RunOverrides = {}): Promise<boolean> =>
    runCommandHandler('upgrade', args, context('/upgrade', overrides, { fromCardAction: true }));

  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });

  return { tmp, channel, sessions, workspaces, activeRuns, agent, controls, upgrade, run, runCard };
}

function appConfig(defaultWorkspace: string): ProfileConfig {
  const config = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
    access: { admins: ['ou-admin'] },
    sandbox: { defaultMode: 'read-only', maxMode: 'workspace-write' },
    preferences: { maxConcurrentRuns: 2 },
  });
  config.workspaces.default = defaultWorkspace;
  return config;
}

function message(
  content: string,
  opts: {
    chatId: string;
    senderId: string;
  },
): NormalizedMessage {
  return {
    messageId: `om-${content.replace(/\W+/g, '-').slice(0, 20)}`,
    chatId: opts.chatId,
    chatType: 'p2p',
    senderId: opts.senderId,
    senderName: 'User',
    content,
    resources: [],
    mentions: [],
    mentionedBot: false,
  } as unknown as NormalizedMessage;
}

function lastContent(channel: FakeChannel): Record<string, unknown> {
  const content = channel.sent.at(-1)?.content;
  expect(content).toBeTypeOf('object');
  return content as Record<string, unknown>;
}

function lastMarkdown(channel: FakeChannel): string {
  const content = lastContent(channel);
  expect(content.markdown).toBeTypeOf('string');
  return content.markdown as string;
}
