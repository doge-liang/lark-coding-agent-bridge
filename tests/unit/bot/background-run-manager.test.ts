import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackgroundRunManager, type BgStartResult } from '../../../src/bot/background-run-manager.js';
import { BgTasksStore } from '../../../src/session/bg-tasks-store.js';
import type { AgentEvent } from '../../../src/agent/types.js';
import type { RunExecution } from '../../../src/runtime/run-executor.js';

const cleanups: Array<() => void> = [];

function makeStore(): BgTasksStore {
  const dir = mkdtempSync(join(tmpdir(), 'bgmgr-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new BgTasksStore(join(dir, 'bg.db'));
  cleanups.push(() => store.close());
  return store;
}

/** A controllable fake RunExecution: push events, then end() to close the stream. */
function controllableExec(): {
  exec: RunExecution;
  emit: (evt: AgentEvent) => void;
  end: () => void;
  stopped: () => boolean;
} {
  const queue: AgentEvent[] = [];
  const waiters = new Set<() => void>();
  let closed = false;
  let stopped = false;
  const wake = (): void => {
    for (const w of [...waiters]) w();
  };
  const subscribe = async function* (): AsyncGenerator<AgentEvent> {
    let i = 0;
    for (;;) {
      if (i < queue.length) {
        yield queue[i++]!;
        continue;
      }
      if (closed) return;
      await new Promise<void>((resolve) => {
        const w = (): void => {
          waiters.delete(w);
          resolve();
        };
        waiters.add(w);
      });
    }
  };
  const exec = {
    runId: 'r',
    scopeId: 's',
    run: {} as never,
    handle: {} as never,
    subscribe,
    stop: async () => {
      stopped = true;
      closed = true;
      wake();
    },
  } as unknown as RunExecution;
  return {
    exec,
    emit: (evt) => {
      queue.push(evt);
      wake();
    },
    end: () => {
      closed = true;
      wake();
    },
    stopped: () => stopped,
  };
}

async function waitFor(pred: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

interface Harness {
  mgr: BackgroundRunManager;
  store: BgTasksStore;
  notifications: Array<{ chatId: string; text: string }>;
  startRun: ReturnType<typeof vi.fn>;
  cardUpdates: number;
}

function makeManager(opts: {
  store: BgTasksStore;
  startImpl: (input: { scopeId: string; prompt: string; resumeSessionId?: string }) => Promise<BgStartResult>;
  maxConcurrent?: number;
}): Harness {
  const notifications: Array<{ chatId: string; text: string }> = [];
  let cardUpdates = 0;
  const startRun = vi.fn(opts.startImpl);
  const mgr = new BackgroundRunManager({
    store: opts.store,
    startRun: startRun as never,
    postCard: async () => 'card-1',
    updateCard: async () => {
      cardUpdates++;
    },
    notify: async (chatId, text) => {
      notifications.push({ chatId, text });
    },
    maxConcurrent: opts.maxConcurrent ?? 5,
    cardMinIntervalMs: 0,
    now: () => 12345,
    genId: (() => {
      let n = 0;
      return () => `bg-${++n}`;
    })(),
  });
  return { mgr, store: opts.store, notifications, startRun, get cardUpdates() { return cardUpdates; } } as Harness;
}

describe('BackgroundRunManager', () => {
  afterEach(() => {
    cleanups.splice(0).forEach((c) => c());
    vi.restoreAllMocks();
  });

  it('submits, persists session id, drives to done and notifies with the text', async () => {
    const store = makeStore();
    const ctrl = controllableExec();
    const h = makeManager({ store, startImpl: async () => ({ ok: true, execution: ctrl.exec }) });

    const res = await h.mgr.submit({ chatId: 'oc_a', scopeBase: 'oc_a', actorId: 'ou_x', chatType: 'p2p', prompt: 'build it' });
    expect(res).toEqual({ ok: true, taskId: 'bg-1' });
    expect(store.get('bg-1')?.status).toBe('running');
    expect(store.get('bg-1')?.cardId).toBe('card-1');
    expect(h.startRun).toHaveBeenCalledWith({
      scopeId: 'oc_a:bg:bg-1',
      chatId: 'oc_a',
      prompt: 'build it',
      actorId: 'ou_x',
      chatType: 'p2p',
    });

    ctrl.emit({ type: 'system', sessionId: 'sess-42' });
    ctrl.emit({ type: 'text', delta: 'all done' });
    ctrl.emit({ type: 'done', terminationReason: 'normal' });

    await waitFor(() => store.get('bg-1')?.status === 'done');
    const task = store.get('bg-1')!;
    expect(task.sessionId).toBe('sess-42');
    expect(h.notifications).toHaveLength(1);
    expect(h.notifications[0]!.text).toContain('all done');
    expect(h.notifications[0]!.text).toContain('已完成');
  });

  it('rejects a submit when the background pool is full', async () => {
    const store = makeStore();
    const ctrl = controllableExec();
    const h = makeManager({
      store,
      startImpl: async () => ({ ok: true, execution: ctrl.exec }),
      maxConcurrent: 1,
    });

    const first = await h.mgr.submit({ chatId: 'oc_a', scopeBase: 'oc_a', actorId: 'ou_x', chatType: 'p2p', prompt: 'one' });
    expect(first.ok).toBe(true);
    const second = await h.mgr.submit({ chatId: 'oc_a', scopeBase: 'oc_a', actorId: 'ou_x', chatType: 'p2p', prompt: 'two' });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toContain('上限');

    // finish the first so the slot frees and a later submit is accepted again
    ctrl.emit({ type: 'done', terminationReason: 'normal' });
    await waitFor(() => store.get('bg-1')?.status === 'done');
    const third = await h.mgr.submit({ chatId: 'oc_a', scopeBase: 'oc_a', actorId: 'ou_x', chatType: 'p2p', prompt: 'three' });
    expect(third.ok).toBe(true);
  });

  it('marks error and returns the reason when startRun fails', async () => {
    const store = makeStore();
    const h = makeManager({ store, startImpl: async () => ({ ok: false, reason: '工作区不可用' }) });
    const res = await h.mgr.submit({ chatId: 'oc_a', scopeBase: 'oc_a', actorId: 'ou_x', chatType: 'p2p', prompt: 'x' });
    expect(res.ok).toBe(false);
    expect(store.get('bg-1')?.status).toBe('error');
  });

  it('stops a live task via the execution handle', async () => {
    const store = makeStore();
    const ctrl = controllableExec();
    const h = makeManager({ store, startImpl: async () => ({ ok: true, execution: ctrl.exec }) });
    await h.mgr.submit({ chatId: 'oc_a', scopeBase: 'oc_a', actorId: 'ou_x', chatType: 'p2p', prompt: 'long' });
    await waitFor(() => h.mgr.liveCount() === 1);
    expect(await h.mgr.stop('bg-1')).toBe(true);
    expect(ctrl.stopped()).toBe(true);
    expect(await h.mgr.stop('nope')).toBe(false);
  });

  it('recovers active tasks by resuming their session id', async () => {
    const store = makeStore();
    store.create({
      taskId: 'bg-old',
      chatId: 'oc_a',
      scopeId: 'oc_a:bg:bg-old',
      actorId: 'ou_x',
      chatType: 'p2p',
      prompt: 'resume me',
      sessionId: 'sess-old',
      cwd: '/ws',
      cardId: 'card-old',
      status: 'running',
      createdAt: 1,
      updatedAt: 1,
    });
    const ctrl = controllableExec();
    const h = makeManager({ store, startImpl: async () => ({ ok: true, execution: ctrl.exec }) });

    const resumed = await h.mgr.recover();
    expect(resumed).toBe(1);
    expect(h.startRun).toHaveBeenCalledWith({
      scopeId: 'oc_a:bg:bg-old',
      chatId: 'oc_a',
      prompt: 'resume me',
      actorId: 'ou_x',
      chatType: 'p2p',
    });
    ctrl.emit({ type: 'done', terminationReason: 'normal' });
    await waitFor(() => store.get('bg-old')?.status === 'done');
  });
});
