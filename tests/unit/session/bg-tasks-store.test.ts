import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BgTasksStore, type BgTask } from '../../../src/session/bg-tasks-store.js';

const cleanups: Array<() => void> = [];

function makeStore(): BgTasksStore {
  const dir = mkdtempSync(join(tmpdir(), 'bgtasks-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new BgTasksStore(join(dir, 'bg-tasks.db'));
  cleanups.push(() => store.close());
  return store;
}

function task(overrides: Partial<BgTask> = {}): BgTask {
  return {
    taskId: 'bg-1',
    chatId: 'oc_a',
    scopeId: 'oc_a:bg:bg-1',
    actorId: 'ou_actor',
    chatType: 'p2p',
    prompt: 'do the thing',
    cwd: '/tmp/ws',
    status: 'running',
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

describe('BgTasksStore', () => {
  afterEach(() => {
    cleanups.splice(0).forEach((c) => c());
  });

  it('persists a task and round-trips optional fields', () => {
    const store = makeStore();
    store.create(task({ sessionId: 'sess-9', model: 'fable', permissionMode: 'plan', cardId: 'c1' }));
    const got = store.get('bg-1');
    expect(got).toMatchObject({
      taskId: 'bg-1',
      chatId: 'oc_a',
      scopeId: 'oc_a:bg:bg-1',
      prompt: 'do the thing',
      sessionId: 'sess-9',
      model: 'fable',
      permissionMode: 'plan',
      cardId: 'c1',
      status: 'running',
    });
  });

  it('omits absent optional fields rather than returning null', () => {
    const store = makeStore();
    store.create(task());
    const got = store.get('bg-1')!;
    expect('sessionId' in got).toBe(false);
    expect('cardId' in got).toBe(false);
    expect('model' in got).toBe(false);
  });

  it('patches only the provided fields and advances updatedAt', () => {
    const store = makeStore();
    store.create(task());
    store.update('bg-1', { status: 'done', sessionId: 'sess-x', lastNode: '完成', updatedAt: 2000 });
    const got = store.get('bg-1')!;
    expect(got.status).toBe('done');
    expect(got.sessionId).toBe('sess-x');
    expect(got.lastNode).toBe('完成');
    expect(got.updatedAt).toBe(2000);
    expect(got.prompt).toBe('do the thing'); // untouched
  });

  it('lists a chat newest-first', () => {
    const store = makeStore();
    store.create(task({ taskId: 'bg-1', createdAt: 1000 }));
    store.create(task({ taskId: 'bg-2', scopeId: 'oc_a:bg:bg-2', createdAt: 2000 }));
    store.create(task({ taskId: 'bg-3', chatId: 'oc_b', scopeId: 'oc_b:bg:bg-3', createdAt: 1500 }));
    const list = store.listByChat('oc_a').map((t) => t.taskId);
    expect(list).toEqual(['bg-2', 'bg-1']);
  });

  it('lists only active tasks (running/resuming) for recovery and counts them', () => {
    const store = makeStore();
    store.create(task({ taskId: 'bg-1', status: 'running', createdAt: 1000 }));
    store.create(task({ taskId: 'bg-2', scopeId: 'oc_a:bg:bg-2', status: 'resuming', createdAt: 1100 }));
    store.create(task({ taskId: 'bg-3', scopeId: 'oc_a:bg:bg-3', status: 'done', createdAt: 1200 }));
    store.create(task({ taskId: 'bg-4', scopeId: 'oc_a:bg:bg-4', status: 'interrupted', createdAt: 1300 }));
    expect(store.listActive().map((t) => t.taskId)).toEqual(['bg-1', 'bg-2']);
    expect(store.countActive()).toBe(2);
  });

  it('rejects an invalid status at the DB CHECK constraint', () => {
    const store = makeStore();
    store.create(task());
    // The schema's CHECK guards the column even against a raw write, so a bad
    // status can never reach a reader in the first place.
    // @ts-expect-error reaching into the private db for the test
    const db = store.db as import('better-sqlite3').Database;
    expect(() =>
      db.prepare("update bg_tasks set status = 'bogus' where task_id = 'bg-1'").run(),
    ).toThrow(/CHECK constraint/);
  });
});
