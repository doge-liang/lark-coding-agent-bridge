import type { NormalizedMessage } from '@larksuite/channel';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { log } from '../../../src/core/logger.js';
import type { AgentEvent, AgentRunOptions } from '../../../src/agent/types.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import {
  FakeAgentAdapter,
  type FakeAgentEvents,
  type FakeAgentRun,
} from '../../helpers/fake-agent.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const sdkMock = vi.hoisted(() => ({
  channel: undefined as FakeLarkChannel | undefined,
  createLarkChannel: vi.fn(() => {
    if (!sdkMock.channel) throw new Error('fake channel not configured');
    return sdkMock.channel;
  }),
}));

vi.mock('@larksuite/channel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@larksuite/channel')>();
  return {
    ...actual,
    createLarkChannel: sdkMock.createLarkChannel,
  };
});

import { startChannel } from '../../../src/bot/channel.js';

interface MessageHandlerMap {
  message?: (msg: NormalizedMessage) => Promise<void> | void;
}

interface FakeLarkChannel {
  botIdentity: { openId: string; name: string };
  handlers: MessageHandlerMap;
  sent: Array<{ chatId: string; content: unknown; options?: unknown }>;
  rawClient: {
    request: ReturnType<typeof vi.fn>;
    application: {
      v6: {
        application: {
          get: ReturnType<typeof vi.fn>;
        };
      };
    };
    im: {
      v1: {
        message: {
          get: ReturnType<typeof vi.fn>;
        };
        messageReaction: {
          create: ReturnType<typeof vi.fn>;
          delete: ReturnType<typeof vi.fn>;
        };
      };
    };
  };
  on(handlers: MessageHandlerMap): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getChatMode(chatId: string): Promise<'group' | 'topic'>;
  getConnectionStatus(): { state: 'connected'; reconnectAttempts: number };
  send(chatId: string, content: unknown, options?: unknown): Promise<void>;
  stream(chatId: string, input: unknown, options?: unknown): Promise<void>;
  addReaction(messageId: string, emojiType: string): Promise<string>;
  removeReaction(messageId: string, reactionId: string): Promise<void>;
}

type StreamFn = FakeLarkChannel['stream'];

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  sdkMock.channel = undefined;
  sdkMock.createLarkChannel.mockClear();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('markdown stream startup failures', () => {
  it('delegates automatic keepalive to the SDK WebSocket reconnect path', async () => {
    const h = await createHarness();
    await startTestBridge(h);

    const opts = (sdkMock.createLarkChannel.mock.calls as unknown[][])[0]?.[0] as
      | { keepalive?: { enabled?: boolean; onUnrecoverable?: unknown } }
      | undefined;
    expect(opts?.keepalive?.enabled).toBe(true);
    expect(opts?.keepalive?.onUnrecoverable).toBeTypeOf('function');
  });

  it('does not leave the IM queue blocked when the agent exits before stream producer starts', async () => {
    const h = await createHarness();
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_first', 'first'));
    await waitFor(() => h.agent.runOptions.length === 1);

    await h.channel.handlers.message?.(message('om_second', 'second'));
    await waitFor(() => h.agent.runOptions.length === 2);

    expect(h.channel.rawClient.im.v1.messageReaction.delete).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { message_id: 'om_first', reaction_id: 'reaction_1' },
      }),
    );
    expect(lastMarkdown(h.channel)).toContain('agent 失败');
    expect(lastMarkdown(h.channel)).toContain('codex exited with code 1');
  });

  it('does not wait for the working reaction before draining a failed agent run', async () => {
    const reaction = deferred<{ data: { reaction_id: string } }>();
    const h = await createHarness({
      reactionCreate: () => reaction.promise,
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_first', 'first'));
    await waitFor(() => h.agent.runOptions.length === 1);

    await h.channel.handlers.message?.(message('om_second', 'second'));
    await waitFor(() => h.agent.runOptions.length === 2, 1000);

    expect(lastMarkdown(h.channel)).toContain('agent 失败');

    reaction.resolve({ data: { reaction_id: 'reaction_1' } });
    await waitFor(() => h.channel.rawClient.im.v1.messageReaction.delete.mock.calls.length > 0);
  });

  it('logs stream failures that arrive after terminal grace expires', async () => {
    const streamFailure = deferred<void>();
    let streamProducerStarted = false;
    const h = await createHarness({
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        if (producer) {
          streamProducerStarted = true;
          void producer({ setContent: vi.fn(async () => {}) });
        }
        await streamFailure.promise;
      },
    });
    const fail = vi.spyOn(log, 'fail').mockImplementation(() => {});
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_first', 'first'));
    await waitFor(() => streamProducerStarted);
    await waitFor(
      () => h.channel.rawClient.im.v1.messageReaction.delete.mock.calls.length > 0,
      4500,
    );

    await h.channel.handlers.message?.(message('om_second', 'second'));
    await waitFor(() => h.agent.runOptions.length === 2);

    streamFailure.reject(new Error('late stream failed'));

    await waitFor(() =>
      fail.mock.calls.some((call) =>
        call[0] === 'stream' &&
        call[1] instanceof Error &&
        call[1].message === 'late stream failed' &&
        (call[2] as { step?: string } | undefined)?.step === 'stream-terminal-late',
      ),
    );
  }, 10_000);

  it('keeps markdown stream updates below the rollover limit for long tool-heavy runs', async () => {
    const markdownUpdates: string[] = [];
    const events: AgentEvent[] = [];
    for (let i = 0; i < 450; i++) {
      const id = `tool-${i}`;
      events.push({
        type: 'tool_use',
        id,
        name: 'Bash',
        input: {
          command: `printf '${String(i).padStart(3, '0')}-${'x'.repeat(120)}'`,
        },
      });
      events.push({
        type: 'tool_result',
        id,
        output: 'ok',
        isError: false,
      });
    }
    events.push({ type: 'text', delta: '最终结果保留在尾部。' });
    events.push({ type: 'done', terminationReason: 'normal' });

    const h = await createHarness({
      agentEvents: [events],
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        if (!producer) throw new Error('expected markdown stream input');
        await producer({
          setContent: async (markdown: string): Promise<void> => {
            markdownUpdates.push(markdown);
          },
        });
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_first', 'run many tools'));

    await waitFor(() => markdownUpdates.length > 0, 10_000);
    expect(Math.max(...markdownUpdates.map((content) => content.length))).toBeLessThanOrEqual(24_000);
    expect(markdownUpdates.some((content) => content.includes('已省略较早'))).toBe(true);
    const finalMarkdown = markdownUpdates.at(-1) ?? '';
    expect(finalMarkdown).toContain('最终结果保留在尾部');
    expect(finalMarkdown).not.toContain('正在调用工具');
  });

  it('sends a terminal fallback card when card stream transport stalls after render completes', async () => {
    const streamNeverFinishes = deferred<void>();
    let producerCompleted = false;
    const h = await createHarness({
      messageReply: 'card',
      agentEvents: [
        [
          { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
          { type: 'tool_result', id: 'tool-1', output: '/repo', isError: false },
          { type: 'done', terminationReason: 'normal' },
        ],
      ],
      stream: async (_chatId, input) => {
        const producer = (input as {
          card?: {
            producer: (ctrl: { update(next: object | ((current: object) => object)): Promise<void> }) => Promise<void>;
          };
        }).card?.producer;
        if (!producer) throw new Error('expected card stream input');
        await producer({ update: vi.fn(async () => {}) });
        producerCompleted = true;
        await streamNeverFinishes.promise;
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_first', 'first'));

    await waitFor(() => producerCompleted);
    await waitFor(() => h.channel.sent.length > 0, 4500);
    const card = JSON.stringify(lastCard(h.channel));
    expect(card).toContain('"streaming_mode":false');
    expect(card).toContain('已完成');
    expect(card).not.toContain('正在调用工具');
  }, 10_000);

  it('sends a terminal fallback markdown when markdown stream transport stalls after render completes', async () => {
    const streamNeverFinishes = deferred<void>();
    let producerCompleted = false;
    const markdownUpdates: string[] = [];
    const h = await createHarness({
      agentEvents: [
        [
          { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
          { type: 'tool_result', id: 'tool-1', output: '/repo', isError: false },
          { type: 'text', delta: '最终结果应该补发。' },
          { type: 'done', terminationReason: 'normal' },
        ],
      ],
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        if (!producer) throw new Error('expected markdown stream input');
        await producer({
          setContent: async (markdown: string): Promise<void> => {
            markdownUpdates.push(markdown);
          },
        });
        producerCompleted = true;
        await streamNeverFinishes.promise;
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_first', 'first'));

    await waitFor(() => producerCompleted);
    await waitFor(() => h.channel.sent.length > 0, 4500);
    const markdown = lastMarkdown(h.channel);
    expect(markdown).toContain('最终结果应该补发');
    expect(markdown).not.toContain('正在调用工具');
    expect(markdownUpdates.at(-1)).toContain('最终结果应该补发');
  }, 10_000);

  it('sends final markdown separately when the stream outlives Lark card lifecycle', async () => {
    const realNow = Date.now.bind(Date);
    let offsetMs = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offsetMs);

    const markdownUpdates: string[] = [];
    const h = await createHarness({
      agentEvents: [
        [
          { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'sleep 600' } },
          { type: 'tool_result', id: 'tool-1', output: 'done', isError: false },
          { type: 'text', delta: '长任务最终结果必须可见。' },
          { type: 'done', terminationReason: 'normal' },
        ],
      ],
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        if (!producer) throw new Error('expected markdown stream input');
        await producer({
          setContent: async (markdown: string): Promise<void> => {
            markdownUpdates.push(markdown);
            if (markdown.includes('长任务最终结果必须可见')) {
              offsetMs = 10 * 60_000 + 1;
            }
          },
        });
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_first', 'run for a long time'));

    await waitForWallClock(() =>
      markdownUpdates.some((content) => content.includes('长任务最终结果必须可见')),
    );
    await waitForWallClock(() => h.channel.sent.length > 0, 1000);
    const markdown = lastMarkdown(h.channel);
    expect(markdown).toContain('长任务最终结果必须可见');
    expect(markdown).not.toContain('正在调用工具');
  });

  it('sends final markdown when the SDK silently abandons stream updates', async () => {
    let updateCount = 0;
    let failureReported = false;
    let producerCompleted = false;
    const h = await createHarness({
      agentEvents: [
        [
          { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
          { type: 'tool_result', id: 'tool-1', output: '/repo', isError: false },
          { type: 'text', delta: '静默失败后仍应看到最终结果。' },
          { type: 'done', terminationReason: 'normal' },
        ],
      ],
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        if (!producer) throw new Error('expected markdown stream input');
        await producer({
          setContent: async (): Promise<void> => {
            updateCount++;
            if (failureReported || updateCount < 2) return;
            failureReported = true;
            const opts = (sdkMock.createLarkChannel.mock.calls as unknown[][])[0]?.[0] as
              | { logger?: { warn(...args: unknown[]): void } }
              | undefined;
            // @larksuite/channel catches this CardKit update failure, logs it,
            // disables every later update, and still resolves channel.stream().
            opts?.logger?.warn('[stream] update failed', new Error('CardKit HTTP 500'));
          },
        });
        producerCompleted = true;
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_first', 'run a long tool chain'));

    await waitFor(() => producerCompleted);
    await waitFor(
      () => h.channel.rawClient.im.v1.messageReaction.delete.mock.calls.length > 0,
    );
    expect(failureReported).toBe(true);
    const markdown = lastMarkdown(h.channel);
    expect(markdown).toContain('静默失败后仍应看到最终结果');
    expect(markdown).not.toContain('正在调用工具');
  });

  it('rotates an active markdown stream and refreshes long-tool heartbeat text', async () => {
    const streams: string[][] = [];
    const agent = new CompletableLongToolAgentAdapter();
    const h = await createHarness({
      agent,
      streamTiming: {
        markdownRotateAfterMs: 80,
        toolHeartbeatMs: 20,
      },
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        if (!producer) throw new Error('expected markdown stream input');
        const updates: string[] = [];
        streams.push(updates);
        await producer({
          setContent: async (markdown: string): Promise<void> => {
            updates.push(markdown);
          },
        });
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_first', 'run a long tool'));

    await waitFor(() => streams.length >= 2, 1500);
    expect(streams.flat().some((content) => content.includes('已运行'))).toBe(true);
    expect(streams[1]?.some((content) => content.includes('正在调用工具'))).toBe(true);

    agent.finish();
    await waitFor(() =>
      streams.flat().some((content) => content.includes('长工具执行完成')),
    );
    expect(streams.flat().at(-1)).not.toContain('正在调用工具');
  });

  it('acknowledges queued messages immediately while a run is active', async () => {
    const markdownUpdates: string[] = [];
    const agent = new CompletableLongToolAgentAdapter();
    const h = await createHarness({
      agent,
      streamTiming: {
        markdownRotateAfterMs: 5_000,
        toolHeartbeatMs: 20,
      },
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        if (!producer) throw new Error('expected markdown stream input');
        await producer({
          setContent: async (markdown: string): Promise<void> => {
            markdownUpdates.push(markdown);
          },
        });
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_first', 'run a long tool'));
    await waitFor(() => markdownUpdates.some((content) => content.includes('正在调用工具')));

    await h.channel.handlers.message?.(message('om_second', 'is it still running?'));

    await waitFor(() => h.channel.sent.length > 0);
    expect(lastMarkdown(h.channel)).toContain('消息已排队（第 1 条）');
    expect(lastMarkdown(h.channel)).toContain('/stop');
    expect(h.channel.sent.at(-1)?.options).toMatchObject({ replyTo: 'om_second' });

    agent.finish();
  });

  it('marks the card interrupted promptly when a silent tool run is stopped', async () => {
    const updates: unknown[] = [];
    let producerStarted = false;
    const h = await createHarness({
      messageReply: 'card',
      agent: new HangingToolAgentAdapter(),
      stream: async (_chatId, input) => {
        const producer = (input as {
          card?: {
            producer: (ctrl: {
              update(next: object | ((current: object) => object)): Promise<void>;
            }) => Promise<void>;
          };
        }).card?.producer;
        if (!producer) throw new Error('expected card stream input');
        producerStarted = true;
        await producer({
          update: async (card: unknown): Promise<void> => {
            updates.push(card);
          },
        });
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_first', 'run a long tool'));
    await waitFor(() => producerStarted && JSON.stringify(updates.at(-1)).includes('正在调用工具'));

    await h.channel.handlers.message?.(message('om_stop', '/stop'));

    await waitFor(() => JSON.stringify(updates.at(-1)).includes('已被中断'), 1000);
    const finalCard = JSON.stringify(updates.at(-1));
    expect(finalCard).toContain('"streaming_mode":false');
    expect(finalCard).not.toContain('正在调用工具');
  });
});

async function createHarness(options: {
  reactionCreate?: () => Promise<{ data: { reaction_id: string } }>;
  stream?: StreamFn;
  messageReply?: 'markdown' | 'card' | 'text';
  agentEvents?: FakeAgentEvents;
  agent?: FakeAgentAdapter;
  streamTiming?: {
    markdownRotateAfterMs?: number;
    toolHeartbeatMs?: number;
  };
} = {}): Promise<{
  tmp: TmpProfile;
  channel: FakeLarkChannel;
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  controls: ReturnType<typeof createControls>;
  streamTiming?: {
    markdownRotateAfterMs?: number;
    toolHeartbeatMs?: number;
  };
}> {
  const tmp = await createTmpProfile('markdown-stream-startup-failure-');
  const workspace = await realpath(tmp.workspace);
  const baseProfileConfig = createDefaultProfileConfig({
    agentKind: 'codex',
    accounts: {
      app: {
        id: 'cli_test',
        secret: 'secret',
        tenant: 'feishu',
      },
    },
    access: {
      allowedUsers: ['ou_user'],
    },
    codex: {
      binaryPath: '/usr/local/bin/codex',
    },
  });
  const profileConfig = {
    ...baseProfileConfig,
    preferences: {
      ...baseProfileConfig.preferences,
      ...(options.messageReply
        ? { messageReply: options.messageReply, messageReplyMigrated: true }
        : {}),
    },
    workspaces: {
      ...baseProfileConfig.workspaces,
      default: workspace,
    },
  };
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = options.agent ?? new FakeAgentAdapter({
    id: 'codex',
    displayName: 'Codex',
    events: options.agentEvents ?? [
      [
        {
          type: 'error',
          message: 'codex exited with code 1: Error loading config.toml',
          terminationReason: 'failed',
        },
      ],
      [{ type: 'done', terminationReason: 'normal' }],
    ],
  });
  const channel = createFakeLarkChannel(options);
  sdkMock.channel = channel;
  const controls = createControls(profileConfig);
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  return {
    tmp,
    channel,
    agent,
    sessions,
    workspaces,
    profileConfig,
    controls,
    streamTiming: options.streamTiming,
  };
}

async function startTestBridge(h: {
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  controls: ReturnType<typeof createControls>;
  streamTiming?: {
    markdownRotateAfterMs?: number;
    toolHeartbeatMs?: number;
  };
}): Promise<void> {
  const bridge = await startChannel({
    cfg: h.profileConfig,
    agent: h.agent,
    sessions: h.sessions,
    workspaces: h.workspaces,
    controls: h.controls,
    streamTiming: h.streamTiming,
  });
  cleanups.push(() => bridge.disconnect());
}

function createFakeLarkChannel(options: {
  reactionCreate?: () => Promise<{ data: { reaction_id: string } }>;
  stream?: StreamFn;
} = {}): FakeLarkChannel {
  const handlers: MessageHandlerMap = {};
  const sent: FakeLarkChannel['sent'] = [];
  const channel: FakeLarkChannel = {
    handlers,
    sent,
    botIdentity: { openId: 'ou_bot', name: 'Bridge' },
    rawClient: {
      request: vi.fn(async () => ({ data: { items: [] } })),
      application: {
        v6: {
          application: {
            get: vi.fn(async () => ({
              data: { app: { owner: { owner_id: 'ou_owner' } } },
            })),
          },
        },
      },
      im: {
        v1: {
          message: {
            get: vi.fn(async () => ({ data: { items: [] } })),
          },
          messageReaction: {
            create: vi.fn(options.reactionCreate ?? (async () => ({ data: { reaction_id: 'reaction_1' } }))),
            delete: vi.fn(async () => ({})),
          },
        },
      },
    },
    on(nextHandlers) {
      Object.assign(handlers, nextHandlers);
    },
    async connect() {},
    async disconnect() {},
    async getChatMode() {
      return 'group';
    },
    getConnectionStatus() {
      return { state: 'connected', reconnectAttempts: 0 };
    },
    async send(chatId, content, options) {
      sent.push({ chatId, content, options });
    },
    stream: options.stream ?? (async () => {
      await new Promise<void>(() => {});
    }),
    async addReaction(messageId, emojiType) {
      const r = await channel.rawClient.im.v1.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      });
      return (r as { data?: { reaction_id?: string } })?.data?.reaction_id ?? '';
    },
    async removeReaction(messageId, reactionId) {
      await channel.rawClient.im.v1.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      });
    },
  };
  return channel;
}

class HangingToolAgentAdapter extends FakeAgentAdapter {
  override run(opts: AgentRunOptions): FakeAgentRun {
    this.runOptions.push(opts);
    const run = new HangingToolRun(opts);
    this.runs.push(run);
    return run;
  }
}

class CompletableLongToolAgentAdapter extends FakeAgentAdapter {
  #finish = deferred<void>();

  override run(opts: AgentRunOptions): FakeAgentRun {
    this.runOptions.push(opts);
    const run = new CompletableLongToolRun(opts, this.#finish.promise);
    this.runs.push(run);
    return run;
  }

  finish(): void {
    this.#finish.resolve();
  }
}

class CompletableLongToolRun implements FakeAgentRun {
  readonly runId: string;
  readonly opts: AgentRunOptions;
  readonly events: AsyncIterable<AgentEvent>;
  readonly waitForExitResult = true;
  stopped = false;
  waitForExitCalls = 0;

  constructor(opts: AgentRunOptions, finish: Promise<void>) {
    this.runId = opts.runId;
    this.opts = opts;
    this.events = this.iterate(finish);
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  async waitForExit(): Promise<boolean> {
    this.waitForExitCalls++;
    return true;
  }

  private async *iterate(finish: Promise<void>): AsyncIterable<AgentEvent> {
    yield { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'sleep 600' } };
    await finish;
    yield { type: 'tool_result', id: 'tool-1', output: 'done', isError: false };
    yield { type: 'text', delta: '长工具执行完成。' };
    yield { type: 'done', terminationReason: 'normal' };
  }
}

class HangingToolRun implements FakeAgentRun {
  readonly runId: string;
  readonly opts: AgentRunOptions;
  readonly events: AsyncIterable<AgentEvent>;
  readonly waitForExitResult = false;
  #stopped = false;
  #waitForExitCalls = 0;

  constructor(opts: AgentRunOptions) {
    this.runId = opts.runId;
    this.opts = opts;
    this.events = this.iterate();
  }

  get stopped(): boolean {
    return this.#stopped;
  }

  get waitForExitCalls(): number {
    return this.#waitForExitCalls;
  }

  async stop(): Promise<void> {
    this.#stopped = true;
  }

  async waitForExit(): Promise<boolean> {
    this.#waitForExitCalls++;
    return this.#stopped;
  }

  private async *iterate(): AsyncIterable<AgentEvent> {
    yield { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'sleep 600' } };
    await new Promise<void>(() => {});
  }
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

function createControls(profileConfig: ReturnType<typeof createDefaultProfileConfig>) {
  return {
    profile: 'codex',
    profileConfig,
    ownerRefreshState: 'unknown' as const,
    async refreshOwner() {},
    async restart() {},
    async exit() {},
    configPath: '/tmp/config.json',
    cfg: profileConfig,
    processId: 'proc_test',
  };
}

function message(messageId: string, content: string): NormalizedMessage {
  return {
    messageId,
    chatId: 'oc_dm',
    chatType: 'p2p',
    senderId: 'ou_user',
    senderName: 'User',
    content,
    rawContentType: 'text',
    resources: [],
    mentionedBot: false,
    createTime: 1760000001000,
  } as unknown as NormalizedMessage;
}

function lastMarkdown(channel: FakeLarkChannel): string {
  const content = channel.sent.at(-1)?.content as { markdown?: string } | undefined;
  expect(content?.markdown).toBeTypeOf('string');
  return content?.markdown ?? '';
}

function lastCard(channel: FakeLarkChannel): object {
  const content = channel.sent.at(-1)?.content as { card?: object } | undefined;
  expect(content?.card).toBeTypeOf('object');
  return content?.card ?? {};
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for async work');
}

async function waitForWallClock(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for async work');
}
