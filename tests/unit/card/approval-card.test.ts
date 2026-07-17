import { describe, expect, it } from 'vitest';
import {
  ApprovalCardTracker,
  renderApprovalCard,
  type ApprovalCardIo,
} from '../../../src/card/approval-card.js';

const REQ = {
  id: 'tu-1',
  toolName: 'Bash',
  input: { command: 'rm -rf build' },
  title: 'Claude wants to run rm -rf build',
  description: 'Claude will delete the build directory',
};

function fakeIo() {
  const sent: object[] = [];
  const updated: Array<{ messageId: string; card: object }> = [];
  let fail = false;
  const io: ApprovalCardIo = {
    send: async (card) => {
      if (fail) throw new Error('send failed');
      sent.push(card);
      return { messageId: `m-${sent.length}` };
    },
    update: async (messageId, card) => {
      updated.push({ messageId, card });
    },
  };
  return { io, sent, updated, setFail: (v: boolean) => (fail = v) };
}

describe('renderApprovalCard', () => {
  it('pending card carries title, tool, deadline note, and signed buttons', () => {
    const card = JSON.stringify(
      renderApprovalCard(REQ, { kind: 'pending', timeoutMinutes: 5, sign: (a) => `tok-${a}` }),
    );
    expect(card).toContain('Claude wants to run rm -rf build');
    expect(card).toContain('Bash');
    expect(card).toContain('5 分钟内未处理将自动拒绝');
    expect(card).toContain('"cmd":"perm.allow"');
    expect(card).toContain('"cmd":"perm.deny"');
    expect(card).toContain('tok-perm.allow');
    expect(card).toContain('tok-perm.deny');
    expect(card).toContain('"arg":"tu-1"');
    expect(card).toContain('__bridge_cb');
  });

  it('resolved cards show outcome and no buttons', () => {
    for (const [outcome, marker] of [
      ['allowed', '已放行'],
      ['denied', '已拒绝'],
      ['timeout', '超时自动拒绝'],
      ['run_ended', '运行已结束'],
    ] as const) {
      const card = JSON.stringify(renderApprovalCard(REQ, { kind: 'resolved', outcome }));
      expect(card).toContain(marker);
      expect(card).not.toContain('"tag":"button"');
    }
  });

  it('falls back to toolName when title is absent', () => {
    const card = JSON.stringify(
      renderApprovalCard({ id: 'x', toolName: 'WebFetch', input: {} }, { kind: 'pending', timeoutMinutes: 5 }),
    );
    expect(card).toContain('WebFetch');
  });
});

describe('ApprovalCardTracker', () => {
  it('sends on request, updates to outcome on resolve, forgets the entry', async () => {
    const { io, sent, updated } = fakeIo();
    const t = new ApprovalCardTracker(io, { timeoutMinutes: 5 });
    await t.onRequest({ type: 'permission_request', ...REQ });
    expect(sent).toHaveLength(1);
    await t.onResolved({ type: 'permission_resolved', id: 'tu-1', decision: 'allow', reason: 'user' });
    expect(updated).toHaveLength(1);
    expect(JSON.stringify(updated[0]!.card)).toContain('已放行');
    await t.onResolved({ type: 'permission_resolved', id: 'tu-1', decision: 'allow', reason: 'user' });
    expect(updated).toHaveLength(1); // second resolve is a no-op
  });

  it('maps reasons to outcomes (timeout, aborted)', async () => {
    const { io, updated } = fakeIo();
    const t = new ApprovalCardTracker(io, { timeoutMinutes: 5 });
    await t.onRequest({ type: 'permission_request', ...REQ });
    await t.onResolved({ type: 'permission_resolved', id: 'tu-1', decision: 'deny', reason: 'timeout' });
    expect(JSON.stringify(updated[0]!.card)).toContain('超时自动拒绝');
  });

  it('sweep marks all unresolved cards as run_ended', async () => {
    const { io, updated } = fakeIo();
    const t = new ApprovalCardTracker(io, { timeoutMinutes: 5 });
    await t.onRequest({ type: 'permission_request', ...REQ });
    await t.onRequest({ type: 'permission_request', ...REQ, id: 'tu-2' });
    await t.sweep();
    expect(updated).toHaveLength(2);
    for (const u of updated) expect(JSON.stringify(u.card)).toContain('运行已结束');
    await t.sweep();
    expect(updated).toHaveLength(2); // idempotent
  });

  it('swallows send failures (adapter timeout still governs the run)', async () => {
    const { io, setFail } = fakeIo();
    setFail(true);
    const t = new ApprovalCardTracker(io, { timeoutMinutes: 5 });
    await expect(t.onRequest({ type: 'permission_request', ...REQ })).resolves.toBeUndefined();
    await expect(t.sweep()).resolves.toBeUndefined();
  });
});
