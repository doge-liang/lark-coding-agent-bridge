import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CardActionEvent, NormalizedMessage } from '@larksuite/channel';
import { claudeCapability, codexCapability } from '../../../src/agent/capability.js';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import type { ChatModeCache } from '../../../src/bot/chat-mode-cache.js';
import { PendingQueue } from '../../../src/bot/pending-queue.js';
import { handleCardAction } from '../../../src/card/dispatcher.js';
import { tryHandleCommand, type CommandContext, type Controls } from '../../../src/commands/index.js';
import { createDefaultProfileConfig, type AgentKind, type ProfileConfig } from '../../../src/config/profile-schema.js';
import { canUseDm } from '../../../src/policy/access.js';
import { evaluateRunPolicy } from '../../../src/policy/run-policy.js';
import { resolveWorkingDirectory } from '../../../src/policy/workspace.js';
import { SessionCatalog, type SessionCatalogIdentity } from '../../../src/session/catalog.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import type { CodexThreadHistoryEntry } from '../../../src/session/codex-history.js';
import type { SessionSummary } from '../../../src/session/history.js';
import { createFakeAgent } from '../../helpers/fake-agent.js';
import { createFakeChannel, type FakeChannel } from '../../helpers/fake-channel.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

interface Harness {
  tmp: TmpProfile;
  channel: FakeChannel;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  catalog: SessionCatalog;
  controls: Controls;
  identity: SessionCatalogIdentity;
  claudeHistory: SessionSummary[];
  codexHistory: CodexThreadHistoryEntry[];
  activeRuns: ActiveRuns;
  pending: PendingQueue;
  run(content: string, options?: { withCatalogIdentity?: boolean; chatMode?: 'p2p' | 'group' | 'topic' }): Promise<boolean>;
  dispatchResumeArg(arg: string): Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];

describe('agent-aware resume commands', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('archives only the current catalog entry when starting a new conversation', async () => {
    const h = await createHarness('claude');
    h.catalog.upsertActive({ ...h.identity, sessionId: 'sess-current', now: 1000 });
    h.catalog.upsertActive({
      ...h.identity,
      agentId: 'codex',
      threadId: 'thread-other-agent',
      now: 1000,
    });

    await expect(h.run('/new')).resolves.toBe(true);

    expect(h.catalog.activeFor(h.identity)).toBeUndefined();
    expect(h.catalog.activeFor({ ...h.identity, agentId: 'codex' })).toMatchObject({
      threadId: 'thread-other-agent',
    });
  });

  it('allows resume use only for the current agent/cwd/policy catalog entry', async () => {
    const h = await createHarness('claude');
    h.catalog.upsertActive({ ...h.identity, sessionId: 'sess-current', now: 1000 });
    h.catalog.upsertActive({
      ...h.identity,
      policyFingerprint: 'stale-fp',
      sessionId: 'sess-stale',
      now: 1000,
    });

    await expect(h.run('/resume use sess-stale')).resolves.toBe(true);
    expect(h.sessions.getRaw('chat-1')).toBeUndefined();
    expect(lastMarkdown(h.channel)).toContain('不可恢复');

    await expect(h.run('/resume use sess-current')).resolves.toBe(true);
    expect(h.sessions.resumeFor('chat-1', h.identity.cwdRealpath)).toBe('sess-current');
    expect(lastMarkdown(h.channel)).toContain('已完成');
  });

  it('resumes the selected Claude history entry from the card button callback', async () => {
    const h = await createHarness('claude');
    h.sessions.set('chat-1', 'sess-current', h.identity.cwdRealpath);
    h.catalog.upsertActive({ ...h.identity, sessionId: 'sess-current', now: 1000 });
    h.claudeHistory.push(
      claudeSession('sess-current', 'current prompt', 1_700_000_100_000),
      claudeSession('sess-target', 'target prompt', 1_700_000_000_000),
    );

    await expect(h.run('/resume')).resolves.toBe(true);

    const card = lastContent(h.channel);
    const rendered = JSON.stringify(card);
    expect(rendered).toContain('current prompt');
    expect(rendered).toContain('target prompt');
    expect(rendered).toContain('sess-tar');

    const nonces = resumeArgsFromCard(card);
    expect(nonces).toHaveLength(2);
    expect(nonces[1]).not.toBe('sess-target');
    await h.dispatchResumeArg(nonces[1]!);

    expect(h.sessions.resumeFor('chat-1', h.identity.cwdRealpath)).toBe('sess-target');
    expect(h.catalog.activeFor(h.identity)).toMatchObject({
      sessionId: 'sess-target',
    });
    expect(lastMarkdown(h.channel)).toContain('已完成');
  });

  it('accepts the current Codex thread without writing it into legacy SessionStore', async () => {
    const h = await createHarness('codex');
    h.catalog.upsertActive({ ...h.identity, threadId: 'thread-current', now: 1000 });

    await expect(h.run('/resume')).resolves.toBe(true);
    const nonce = resumeNonce(lastMarkdown(h.channel));

    await expect(h.run(`/resume use ${nonce}`)).resolves.toBe(true);

    expect(h.sessions.getRaw('chat-1')).toBeUndefined();
    expect(lastMarkdown(h.channel)).toContain('已完成');
  });

  it('falls back to an audit-safe reply when resume confirmation is rejected', async () => {
    const h = await createHarness('codex');
    h.catalog.upsertActive({ ...h.identity, threadId: 'thread-current', now: 1000 });
    await expect(h.run('/resume')).resolves.toBe(true);
    const nonce = resumeNonce(lastMarkdown(h.channel));
    const originalSend = h.channel.send.bind(h.channel);
    let attempts = 0;
    h.channel.send = async (...args) => {
      attempts += 1;
      if (attempts === 1) {
        const err = new Error('The messages do NOT pass the audit.') as Error & { code: number };
        err.code = 230028;
        throw err;
      }
      return originalSend(...args);
    };

    await expect(h.run(`/resume use ${nonce}`)).resolves.toBe(true);

    expect(attempts).toBe(2);
    expect(lastMarkdown(h.channel)).toBe('命令已处理。');
  });

  it('shows only the current catalog-backed Codex thread in /resume', async () => {
    const h = await createHarness('codex');
    h.catalog.upsertActive({ ...h.identity, threadId: 'thread-current', now: 1000 });

    await expect(h.run('/resume')).resolves.toBe(true);

    expect(lastMarkdown(h.channel)).toContain('当前 Codex thread 可恢复');
    expect(lastMarkdown(h.channel)).toMatch(/\/resume use [a-f0-9-]+/);
    expect(lastMarkdown(h.channel)).not.toContain('thread-current');
  });

  it('does not accept raw Codex thread ids as resume candidates', async () => {
    const h = await createHarness('codex');
    h.catalog.upsertActive({ ...h.identity, threadId: 'thread-current', now: 1000 });

    await expect(h.run('/resume use thread-current')).resolves.toBe(true);

    expect(h.sessions.getRaw('chat-1')).toBeUndefined();
    expect(lastMarkdown(h.channel)).toContain('请先用 `/resume`');
  });

  it('does not fall back to legacy SessionStore when Codex catalog identity is missing', async () => {
    const h = await createHarness('codex');

    await expect(h.run('/resume use thread-current', { withCatalogIdentity: false })).resolves.toBe(true);

    expect(h.sessions.getRaw('chat-1')).toBeUndefined();
    expect(lastMarkdown(h.channel)).toContain('当前上下文没有可恢复的 Codex thread');
  });

  it('does not list Claude local history for Codex when no current thread is recorded', async () => {
    const h = await createHarness('codex');

    await expect(h.run('/resume')).resolves.toBe(true);

    expect(lastContentString(h.channel)).toContain('此 cwd 下没有历史会话');
  });

  it('lists Codex history for the current cwd and resumes the selected thread through a nonce', async () => {
    const h = await createHarness('codex');
    h.codexHistory.push(
      codexThread('thread-alpha-secret', 'alpha prompt', 1_700_000_100_000),
      codexThread('thread-beta-secret', 'beta prompt', 1_700_000_000_000),
    );

    await expect(h.run('/resume')).resolves.toBe(true);

    const card = lastContent(h.channel);
    const rendered = JSON.stringify(card);
    expect(rendered).toContain('alpha prompt');
    expect(rendered).toContain('beta prompt');
    expect(rendered).not.toContain('thread-alpha-secret');
    expect(rendered).not.toContain('thread-beta-secret');

    const nonces = resumeArgsFromCard(card);
    expect(nonces).toHaveLength(2);
    await expect(h.run(`/resume use ${nonces[1]}`)).resolves.toBe(true);

    expect(h.catalog.activeFor(h.identity)).toMatchObject({
      threadId: 'thread-beta-secret',
    });
    expect(h.sessions.getRaw('chat-1')).toBeUndefined();
    expect(lastMarkdown(h.channel)).toContain('已完成');
  });

  it('resumes a Codex history selection from the card button callback', async () => {
    const h = await createHarness('codex');
    h.codexHistory.push(codexThread('thread-alpha-secret', 'alpha prompt', 1_700_000_100_000));

    await expect(h.run('/resume')).resolves.toBe(true);

    const [nonce] = resumeArgsFromCard(lastContent(h.channel));
    expect(nonce).toBeTypeOf('string');
    await h.dispatchResumeArg(nonce!);

    expect(h.catalog.activeFor(h.identity)).toMatchObject({
      threadId: 'thread-alpha-secret',
    });
    expect(lastMarkdown(h.channel)).toContain('已完成');
  });

  it('keeps Codex resume history details out of group chats like Claude', async () => {
    const h = await createHarness('codex');
    h.codexHistory.push(codexThread('thread-alpha-secret', 'alpha prompt', 1_700_000_100_000));

    await expect(h.run('/resume', { chatMode: 'group' })).resolves.toBe(true);

    const rendered = lastContentString(h.channel);
    expect(rendered).toContain('私聊');
    expect(rendered).not.toContain('alpha prompt');
    expect(rendered).not.toContain('thread-alpha-secret');
  });

  it('labels Codex status as session while reading the recorded thread id', async () => {
    const h = await createHarness('codex');

    await expect(h.run('/status')).resolves.toBe(true);
    let status = JSON.stringify(lastContent(h.channel));
    expect(status).toContain('**session**');
    expect(status).toContain('未建立');
    expect(status).not.toContain('**thread**');
    expect(status).not.toContain('**conversation**');

    h.catalog.upsertActive({ ...h.identity, threadId: 'thread-current', now: 1000 });
    await expect(h.run('/status')).resolves.toBe(true);

    status = JSON.stringify(lastContent(h.channel));
    expect(status).toContain('**session**');
    expect(status).toContain('thread-c');
    expect(status).toContain('"cmd":"usage"');
    expect(status).not.toContain('未建立');
  });

  it('renders Codex usage and context window for the current thread', async () => {
    const h = await createHarness('codex');
    const codexHome = join(h.tmp.root, 'codex-home');
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    cleanups.push(async () => {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
    });
    h.catalog.upsertActive({ ...h.identity, threadId: 'thread-current', now: 1000 });
    await writeCodexUsageFile(codexHome, 'thread-current');

    await expect(h.run('/usage')).resolves.toBe(true);

    const usage = lastContentString(h.channel);
    expect(usage).toContain('Codex 用量');
    expect(usage).toContain('24.0%');
    expect(usage).toContain('62,088 / 258,400');
    expect(usage).toContain('最近请求');
    expect(usage).toContain('本轮 62,088');
    expect(usage).toContain('累计 448,505');
    expect(usage).toContain('5h 窗口');
    expect(usage).toContain('06-21 16:17 UTC');
    expect(usage).toContain('7d 窗口');
    expect(usage).toContain('06-27 20:09 UTC');
    expect(usage).toContain('"cmd":"status"');
    expect(usage).not.toContain('2026-06-22T');
    expect(usage).not.toContain('last_token_usage');
  });

  it('renders Claude usage from the current session snapshot', async () => {
    const h = await createHarness('claude');
    h.sessions.set('chat-1', 'sess-current', h.tmp.workspace);
    const current = h.sessions.getRaw('chat-1') as unknown as {
      usage?: {
        inputTokens: number;
        cachedInputTokens: number;
        outputTokens: number;
        totalTokens: number;
        updatedAt: string;
      };
    };
    current.usage = {
      inputTokens: 1_000,
      cachedInputTokens: 200,
      outputTokens: 300,
      totalTokens: 1_500,
      updatedAt: '2026-06-25T18:30:00.000Z',
    };

    await expect(h.run('/usage')).resolves.toBe(true);

    const usage = lastContentString(h.channel);
    expect(usage).toContain('Claude 用量');
    expect(usage).toContain('本轮 1,500');
    expect(usage).toContain('输入 1,000');
    expect(usage).toContain('缓存 200');
    expect(usage).toContain('输出 300');
    expect(usage).toContain('06-25 18:30 UTC');
    expect(usage).toContain('sess-cur');
    expect(usage).not.toContain('当前只支持 Codex');
    expect(usage).not.toContain('Codex 用量');
  });

  it('explains that Claude usage needs a completed run snapshot', async () => {
    const h = await createHarness('claude');

    await expect(h.run('/usage')).resolves.toBe(true);

    const usage = lastContentString(h.channel);
    expect(usage).toContain('还没有当前 Claude session 的 usage 快照');
    expect(usage).not.toContain('当前只支持 Codex');
  });

  it('explains that Codex usage needs an active thread', async () => {
    const h = await createHarness('codex');

    await expect(h.run('/usage')).resolves.toBe(true);

    expect(lastMarkdown(h.channel)).toContain('还没有当前 Codex session');
  });

  it('does not list local history from home when no workspace is bound', async () => {
    const h = await createHarness('claude', { bindWorkspace: false, defaultWorkspace: false });

    await expect(h.run('/resume')).resolves.toBe(true);

    expect(lastMarkdown(h.channel)).toContain('请先使用 /cd');
  });
});

async function createHarness(
  agentKind: AgentKind,
  options: { bindWorkspace?: boolean; defaultWorkspace?: boolean } = {},
): Promise<Harness> {
  const tmp = await createTmpProfile(`resume-command-${agentKind}-`);
  const channel = createFakeChannel();
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const catalog = new SessionCatalog(join(tmp.profile, 'session-catalog.json'));
  const claudeHistory: SessionSummary[] = [];
  const codexHistory: CodexThreadHistoryEntry[] = [];
  const activeRuns = new ActiveRuns();
  const pending = new PendingQueue(60_000, () => {});
  const agent = createFakeAgent();
  const profileConfig = appConfig(agentKind);
  if (options.defaultWorkspace !== false) {
    profileConfig.workspaces.default = tmp.workspace;
  }
  const controls = {
    profile: agentKind,
    profileConfig,
    botOwnerId: 'ou-user',
    ownerRefreshState: 'ok',
    async refreshOwner() {},
    restart: vi.fn(async () => {}),
    exit: vi.fn(async () => {}),
    configPath: join(tmp.profile, 'config.json'),
    cfg: profileConfig,
    processId: 'proc-1',
  } satisfies Controls;
  if (options.bindWorkspace !== false) {
    workspaces.setCwd('chat-1', tmp.workspace);
  }
  const identity = await commandIdentity(agentKind, profileConfig, controls, tmp.workspace);
  const chatModeCache = {
    resolve: async () => 'p2p',
  } as unknown as ChatModeCache;

  const run = (
    content: string,
    runOptions: { withCatalogIdentity?: boolean; chatMode?: 'p2p' | 'group' | 'topic' } = {},
  ): Promise<boolean> =>
    tryHandleCommand({
      channel: channel as unknown as CommandContext['channel'],
      msg: message(content),
      scope: 'chat-1',
      chatMode: runOptions.chatMode ?? 'p2p',
      sessions,
      sessionCatalog: catalog,
      sessionCatalogIdentity: runOptions.withCatalogIdentity === false ? undefined : identity,
      workspaces,
      agent,
      activeRuns,
      controls,
      claudeHistoryProvider: async () => claudeHistory,
      codexHistoryProvider: async () => codexHistory,
    });

  const dispatchResumeArg = (arg: string): Promise<void> =>
    handleCardAction({
      channel: channel as unknown as Parameters<typeof handleCardAction>[0]['channel'],
      evt: cardEvent({ cmd: 'resume.use', arg }),
      sessions,
      sessionCatalog: catalog,
      workspaces,
      activeRuns,
      agent,
      controls,
      pending,
      chatModeCache,
    });

  cleanups.push(async () => {
    pending.cancelAll();
    await Promise.all([sessions.flush(), workspaces.flush(), catalog.flush()]);
    await tmp.cleanup();
  });

  return {
    tmp,
    channel,
    sessions,
    workspaces,
    catalog,
    controls,
    identity,
    claudeHistory,
    codexHistory,
    activeRuns,
    pending,
    run,
    dispatchResumeArg,
  };
}

async function writeCodexUsageFile(codexHome: string, threadId: string): Promise<void> {
  const sessionDir = join(codexHome, 'sessions', '2026', '06', '21');
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    join(sessionDir, `rollout-2026-06-21T11-30-12-${threadId}.jsonl`),
    `${JSON.stringify({
      timestamp: '2026-06-21T11:31:33.247Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 444017,
            cached_input_tokens: 301184,
            output_tokens: 4488,
            reasoning_output_tokens: 1720,
            total_tokens: 448505,
          },
          last_token_usage: {
            input_tokens: 61238,
            cached_input_tokens: 52096,
            output_tokens: 850,
            reasoning_output_tokens: 587,
            total_tokens: 62088,
          },
          model_context_window: 258400,
        },
        rate_limits: {
          primary: { used_percent: 14, window_minutes: 300, resets_at: 1782058661 },
          secondary: { used_percent: 25, window_minutes: 10080, resets_at: 1782590960 },
        },
      },
    })}\n`,
    'utf8',
  );
}

function claudeSession(
  sessionId: string,
  preview: string,
  mtime: number,
): SessionSummary {
  return {
    sessionId,
    preview,
    mtime,
    lineCount: 1,
  };
}

async function commandIdentity(
  agentKind: AgentKind,
  profileConfig: ProfileConfig,
  controls: Controls,
  cwd: string,
): Promise<SessionCatalogIdentity> {
  const workspace = await resolveWorkingDirectory(cwd);
  if (!workspace.ok) throw new Error(workspace.userVisible);
  const capability = agentKind === 'codex' ? codexCapability(profileConfig) : claudeCapability(profileConfig);
  const access = canUseDm(profileConfig, controls, 'ou-user');
  const policy = evaluateRunPolicy({
    scope: {
      source: 'im',
      chatId: 'chat-1',
      actorId: 'ou-user',
    },
    attachments: [],
    prompt: '',
    requestedCwd: cwd,
    cwdRealpath: workspace.cwdRealpath,
    access,
    capability,
    profileConfig,
    now: Date.now(),
    codexHome: profileConfig.codex?.codexHome,
    inheritCodexHome: profileConfig.codex?.inheritCodexHome,
  });
  if (!policy.ok) throw new Error(policy.rejectReason.userVisible);
  return {
    scopeId: 'chat-1',
    agentId: capability.agentId,
    cwdRealpath: workspace.cwdRealpath,
    policyFingerprint: policy.policyFingerprint,
  };
}

function appConfig(agentKind: AgentKind): ProfileConfig {
  return createDefaultProfileConfig({
    agentKind,
    accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
    access: { admins: ['ou-user'] },
    ...(agentKind === 'codex' ? { codex: { binaryPath: '/usr/local/bin/codex' } } : {}),
  });
}

function message(content: string): NormalizedMessage {
  return {
    messageId: `om-${content.replace(/\W+/g, '-').slice(0, 20)}`,
    chatId: 'chat-1',
    chatType: 'p2p',
    senderId: 'ou-user',
    senderName: 'User',
    content,
    resources: [],
    mentionedBot: false,
  } as unknown as NormalizedMessage;
}

function cardEvent(value: Record<string, unknown>): CardActionEvent {
  return {
    action: { value },
    chatId: 'chat-1',
    messageId: 'om-card',
    operator: {
      openId: 'ou-user',
      name: 'User',
    },
  } as unknown as CardActionEvent;
}

function lastMarkdown(channel: FakeChannel): string {
  const content = channel.sent.at(-1)?.content as { markdown?: unknown } | undefined;
  expect(content?.markdown).toBeTypeOf('string');
  return content?.markdown as string;
}

function lastContent(channel: FakeChannel): Record<string, unknown> {
  const content = channel.sent.at(-1)?.content;
  expect(content).toBeTypeOf('object');
  return content as Record<string, unknown>;
}

function lastContentString(channel: FakeChannel): string {
  return JSON.stringify(lastContent(channel));
}

function resumeNonce(markdown: string): string {
  const match = markdown.match(/\/resume use ([a-f0-9-]+)/);
  const nonce = match?.[1];
  expect(nonce).toBeTypeOf('string');
  if (!nonce) throw new Error('missing resume nonce');
  return nonce;
}

function resumeArgsFromCard(card: unknown): string[] {
  const out: string[] = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    const action = record.value as Record<string, unknown> | undefined;
    if (action?.cmd === 'resume.use' && typeof action.arg === 'string') out.push(action.arg);
    for (const child of Object.values(record)) {
      if (Array.isArray(child)) child.forEach(visit);
      else visit(child);
    }
  };
  visit(card);
  return out;
}

function codexThread(
  threadId: string,
  preview: string,
  updatedAtMs: number,
): CodexThreadHistoryEntry {
  return {
    threadId,
    sessionId: threadId,
    preview,
    cwd: '/tmp/workspace',
    createdAtMs: updatedAtMs - 1000,
    updatedAtMs,
    source: 'exec',
  };
}
