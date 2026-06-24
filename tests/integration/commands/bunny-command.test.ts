import type { NormalizedMessage } from '@larksuite/channel';
import { afterEach, describe, expect, it } from 'vitest';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import { PendingQueue } from '../../../src/bot/pending-queue.js';
import { tryHandleCommand, type CommandContext, type Controls } from '../../../src/commands/index.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { createFakeAgent } from '../../helpers/fake-agent.js';
import { createFakeChannel, type FakeChannel } from '../../helpers/fake-channel.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

interface Harness {
  tmp: TmpProfile;
  channel: FakeChannel;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  activeRuns: ActiveRuns;
  pending: PendingQueue;
  agent: ReturnType<typeof createFakeAgent>;
  controls: Controls;
  cleanup(): Promise<void>;
  run(content: string): Promise<boolean>;
}

const cleanups: Array<() => Promise<void>> = [];

describe('Bunny command bridge', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('opens the Bunny home card from slash command and floating-menu alias', async () => {
    const h = await createHarness();

    await expect(h.run('/bunny')).resolves.toBe(true);
    expect(lastContent(h.channel)).toHaveProperty('card');
    expect(JSON.stringify(lastContent(h.channel))).toContain('Bunny');
    expect(JSON.stringify(lastContent(h.channel))).toContain('bunny.research');

    await expect(h.run('Bunny')).resolves.toBe(true);
    expect(JSON.stringify(lastContent(h.channel))).toContain('bunny.schedule');
  });

  it('queues explicit Bunny skill actions into a Codex-backed Bunny scope', async () => {
    const h = await createHarness();
    h.workspaces.setCwd('chat-1', h.tmp.workspace);

    await expect(h.run('/bunny research')).resolves.toBe(true);

    const queued = h.pending.cancel('chat-1:bunny');
    expect(queued).toHaveLength(1);
    expect(queued[0]?.content).toBe(
      '[bunny-skill] {"domain":"bunny","action":"research","skill":"research_topics","source":"lark-command","confirmed":false}',
    );
    expect(h.workspaces.cwdFor('chat-1:bunny')).toBe(h.tmp.workspace);
    expect(lastMarkdown(h.channel)).toContain('Bunny 已收到');
  });

  it('refuses Bunny skill actions outside Codex profiles', async () => {
    const h = await createHarness({ agentKind: 'claude' });

    await expect(h.run('/bunny research')).resolves.toBe(true);

    expect(h.pending.cancel('chat-1:bunny')).toHaveLength(0);
    expect(lastMarkdown(h.channel)).toContain('需要当前 profile 使用 Codex');
  });
});

async function createHarness(
  opts: { agentKind?: 'claude' | 'codex' } = {},
): Promise<Harness> {
  const tmp = await createTmpProfile('bunny-command-test-');
  const channel = createFakeChannel();
  const sessions = new SessionStore(`${tmp.profile}/sessions.json`);
  const workspaces = new WorkspaceStore(`${tmp.profile}/workspaces.json`);
  const activeRuns = new ActiveRuns();
  const pending = new PendingQueue(60_000, () => {});
  const agent = createFakeAgent();
  const profileConfig = createDefaultProfileConfig({
    agentKind: opts.agentKind ?? 'codex',
    accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
    ...(opts.agentKind === 'claude'
      ? {}
      : { codex: { binaryPath: 'codex' } }),
  });
  const controls = {
    profile: 'codex',
    profileConfig,
    botOwnerId: 'ou_owner',
    ownerRefreshState: 'ok',
    async refreshOwner() {},
    async restart() {},
    async exit() {},
    configPath: `${tmp.root}/config.json`,
    cfg: profileConfig,
    processId: 'proc-1',
  } satisfies Controls;
  cleanups.push(async () => {
    pending.cancelAll();
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });

  const h: Harness = {
    tmp,
    channel,
    sessions,
    workspaces,
    activeRuns,
    pending,
    agent,
    controls,
    cleanup: async () => {
      pending.cancelAll();
      await Promise.all([sessions.flush(), workspaces.flush()]);
      await tmp.cleanup();
    },
    run: (content: string) =>
      tryHandleCommand({
        channel: channel as unknown as CommandContext['channel'],
        msg: message(content),
        scope: 'chat-1',
        chatMode: 'p2p',
        sessions,
        workspaces,
        activeRuns,
        agent,
        pending,
        controls,
      }),
  };
  return h;
}

function message(content: string): NormalizedMessage {
  return {
    messageId: `om_${content.replace(/\W+/g, '_')}`,
    chatId: 'chat-1',
    chatType: 'p2p',
    senderId: 'ou_user',
    senderName: 'User',
    content,
    rawContentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: Date.now(),
  };
}

function lastContent(channel: FakeChannel): unknown {
  const last = channel.sent.at(-1);
  if (!last) throw new Error('no sent messages');
  return last.content;
}

function lastMarkdown(channel: FakeChannel): string {
  const content = lastContent(channel) as { markdown?: string };
  return content.markdown ?? '';
}
