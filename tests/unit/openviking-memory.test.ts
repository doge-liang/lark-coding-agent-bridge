import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../src/agent/types.js';
import {
  createOpenVikingMemory,
  memorySessionId,
  type MemoryClient,
} from '../../src/openviking/memory.js';

function stubClient(overrides: Partial<MemoryClient> = {}): MemoryClient & {
  find: ReturnType<typeof vi.fn>;
  ensureSession: ReturnType<typeof vi.fn>;
  addMessages: ReturnType<typeof vi.fn>;
  commitSession: ReturnType<typeof vi.fn>;
} {
  return {
    find: vi.fn(async () => []),
    ensureSession: vi.fn(async () => {}),
    addMessages: vi.fn(async () => {}),
    commitSession: vi.fn(async () => {}),
    ...overrides,
  } as never;
}

async function* stream(events: AgentEvent[]): AsyncIterable<AgentEvent> {
  for (const event of events) yield event;
}

const enabled = () => ({ memoryEnabled: true, serverUrl: 'http://127.0.0.1:65530' });
const disabled = () => ({ memoryEnabled: false, serverUrl: 'http://127.0.0.1:65530' });

describe('OpenViking memory', () => {
  it('passes the prompt through untouched when disabled', async () => {
    const client = stubClient();
    const memory = createOpenVikingMemory(disabled, () => client);
    await expect(memory.augmentPrompt('chat-1', 'hello')).resolves.toBe('hello');
    expect(client.find).not.toHaveBeenCalled();
  });

  it('prepends retrieved memories as a framed block', async () => {
    const client = stubClient({
      find: vi.fn(async () => [
        { uri: 'viking://user/memories/a', abstract: '用户偏好使用 pnpm' },
        { uri: 'viking://user/memories/b', abstract: '', overview: '部署走 systemd' },
      ]),
    });
    const memory = createOpenVikingMemory(enabled, () => client);
    const result = await memory.augmentPrompt('chat-1', '原始提问');
    expect(result).toContain('长期记忆');
    expect(result).toContain('- 用户偏好使用 pnpm');
    expect(result).toContain('- 部署走 systemd');
    expect(result.endsWith('原始提问')).toBe(true);
  });

  it('fails open when retrieval throws', async () => {
    const client = stubClient({
      find: vi.fn(async () => {
        throw new Error('connect refused');
      }),
    });
    const memory = createOpenVikingMemory(enabled, () => client);
    await expect(memory.augmentPrompt('chat-1', 'hello')).resolves.toBe('hello');
  });

  it('records prompt + assistant text after a normal completion', async () => {
    const client = stubClient();
    const memory = createOpenVikingMemory(enabled, () => client);
    memory.observeRun({
      scopeId: 'oc_chat:thread-9',
      prompt: '问题',
      events: stream([
        { type: 'text', delta: '第一段' },
        { type: 'text', delta: '第二段' },
        { type: 'done', terminationReason: 'normal' },
      ]),
    });
    await vi.waitFor(() => expect(client.commitSession).toHaveBeenCalled());
    const sessionId = memorySessionId('oc_chat:thread-9');
    expect(client.ensureSession).toHaveBeenCalledWith(sessionId);
    expect(client.addMessages).toHaveBeenCalledWith(sessionId, [
      { role: 'user', content: '问题' },
      { role: 'assistant', content: '第一段第二段' },
    ]);
  });

  it('skips recording for interrupted runs and when disabled', async () => {
    const client = stubClient();
    const memory = createOpenVikingMemory(enabled, () => client);
    memory.observeRun({
      scopeId: 'chat-1',
      prompt: '问题',
      events: stream([
        { type: 'text', delta: '部分回答' },
        { type: 'done', terminationReason: 'interrupted' },
      ]),
    });
    const off = createOpenVikingMemory(disabled, () => client);
    off.observeRun({
      scopeId: 'chat-1',
      prompt: '问题',
      events: stream([{ type: 'done', terminationReason: 'normal' }]),
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(client.ensureSession).not.toHaveBeenCalled();
    expect(client.commitSession).not.toHaveBeenCalled();
  });

  it('sanitizes scope ids into stable session ids', () => {
    expect(memorySessionId('oc_abc:omt_9/x')).toBe('lark-oc_abc-omt_9-x');
  });
});
