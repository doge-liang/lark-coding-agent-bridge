import { describe, expect, it } from 'vitest';
import { renderBgTaskCard } from '../../../src/card/bg-task-card.js';
import type { BgTask } from '../../../src/session/bg-tasks-store.js';

function task(overrides: Partial<BgTask> = {}): BgTask {
  return {
    taskId: 'bg-1',
    chatId: 'oc_a',
    scopeId: 'oc_a:bg:bg-1',
    actorId: 'ou_actor',
    chatType: 'p2p',
    prompt: 'build the thing',
    cwd: '/ws',
    status: 'running',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

// Cards are opaque objects; walk them to assert structure.
function findButton(card: unknown): Record<string, unknown> | undefined {
  const elements = (card as { body?: { elements?: unknown[] } }).body?.elements ?? [];
  return elements.find((e) => (e as { tag?: string }).tag === 'button') as
    | Record<string, unknown>
    | undefined;
}

describe('renderBgTaskCard', () => {
  it('is a schema 2.0 card and shows a stop button while running', () => {
    const card = renderBgTaskCard(
      { task: task(), progress: '运行工具 Bash', text: '' },
      { signCallback: (action) => `token(${action})` },
    );
    expect((card as { schema: string }).schema).toBe('2.0');
    const btn = findButton(card);
    expect(btn).toBeDefined();
    const value = (btn!.behaviors as Array<{ value: Record<string, unknown> }>)[0]!.value;
    expect(value).toMatchObject({
      cmd: 'bg.stop',
      taskId: 'bg-1',
      __bridge_cb: true,
      bridge_token: 'token(bg.stop:bg-1)',
    });
  });

  it('omits the stop button (and token) once the task is terminal', () => {
    const done = renderBgTaskCard(
      { task: task({ status: 'done' }), progress: '已完成', text: 'the result' },
      { signCallback: () => 'tok' },
    );
    expect(findButton(done)).toBeUndefined();
  });

  it('shows a /bg stop hint instead of a dead button when no signer is provided', () => {
    const card = renderBgTaskCard({ task: task(), progress: 'x', text: '' });
    expect(findButton(card)).toBeUndefined();
    const elements = (card as { body: { elements: Array<{ content?: string }> } }).body.elements;
    expect(elements.some((e) => e.content?.includes('/bg stop bg-1'))).toBe(true);
  });
});
