import type { AgentEvent } from '../agent/types';
import { log } from '../core/logger';

type PermissionRequest = Extract<AgentEvent, { type: 'permission_request' }>;
type PermissionResolved = Extract<AgentEvent, { type: 'permission_resolved' }>;

export type ApprovalOutcome = 'allowed' | 'denied' | 'timeout' | 'run_ended';

export interface ApprovalCardIo {
  send(card: object): Promise<{ messageId: string }>;
  update(messageId: string, card: object): Promise<void>;
}

export interface ApprovalCardOptions {
  timeoutMinutes: number;
  sign?: (action: string) => string;
}

const INPUT_PREVIEW_MAX = 600;

const OUTCOME_NOTES: Record<ApprovalOutcome, string> = {
  allowed: '✅ 已放行',
  denied: '🚫 已拒绝',
  timeout: '⏱ 超时自动拒绝',
  run_ended: '⏹ 运行已结束，自动拒绝',
};

export function renderApprovalCard(
  req: {
    id: string;
    toolName: string;
    input: unknown;
    title?: string;
    displayName?: string;
    description?: string;
  },
  view:
    | { kind: 'pending'; timeoutMinutes: number; sign?: (action: string) => string }
    | { kind: 'resolved'; outcome: ApprovalOutcome },
): object {
  const heading = req.title ?? `Claude 请求执行：${req.displayName ?? req.toolName}`;
  const elements: object[] = [
    { tag: 'markdown', content: `**${heading}**` },
    { tag: 'markdown', content: `工具：\`${req.toolName}\`` },
  ];
  const preview = inputPreview(req.input);
  if (preview) {
    elements.push({ tag: 'markdown', content: `\`\`\`\n${preview}\n\`\`\`` });
  }
  if (req.description) {
    elements.push({ tag: 'markdown', content: req.description, text_size: 'notation' });
  }

  if (view.kind === 'pending') {
    elements.push({
      tag: 'markdown',
      content: `_${view.timeoutMinutes} 分钟内未处理将自动拒绝_`,
      text_size: 'notation',
    });
    elements.push({
      tag: 'column_set',
      columns: [
        { tag: 'column', elements: [approvalButton('放行', 'perm.allow', req.id, 'primary', view.sign)] },
        { tag: 'column', elements: [approvalButton('拒绝', 'perm.deny', req.id, 'danger', view.sign)] },
      ],
    });
  } else {
    elements.push({ tag: 'markdown', content: `**${OUTCOME_NOTES[view.outcome]}**` });
  }

  return {
    schema: '2.0',
    config: { summary: { content: heading } },
    body: { elements },
  };
}

function approvalButton(
  label: string,
  cmd: 'perm.allow' | 'perm.deny',
  permissionId: string,
  style: 'primary' | 'danger',
  sign?: (action: string) => string,
): object {
  const value: Record<string, unknown> = { cmd, arg: permissionId };
  if (sign) {
    value.__bridge_cb = true;
    value.bridge_token = sign(cmd);
  }
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: label },
    type: style,
    behaviors: [{ type: 'callback', value }],
  };
}

function inputPreview(input: unknown): string {
  if (input === undefined || input === null) return '';
  const raw = typeof input === 'string' ? input : (JSON.stringify(input, null, 2) ?? '');
  return raw.length > INPUT_PREVIEW_MAX ? `${raw.slice(0, INPUT_PREVIEW_MAX)}…` : raw;
}

interface OpenEntry {
  messageId: string;
  req: PermissionRequest;
}

/**
 * Tracks one approval card per parked permission request. Purely reactive:
 * outcome updates are driven by permission_resolved events (the adapter's
 * settle() funnel is the single timing authority), plus a sweep() for
 * requests still open when the run's event stream ends (the force-resolve
 * on abort lands after the terminal event and never reaches consumers).
 */
export class ApprovalCardTracker {
  private readonly open = new Map<string, OpenEntry>();

  constructor(
    private readonly io: ApprovalCardIo,
    private readonly opts: ApprovalCardOptions,
  ) {}

  async onRequest(evt: PermissionRequest): Promise<void> {
    try {
      const { messageId } = await this.io.send(
        renderApprovalCard(evt, {
          kind: 'pending',
          timeoutMinutes: this.opts.timeoutMinutes,
          ...(this.opts.sign ? { sign: this.opts.sign } : {}),
        }),
      );
      this.open.set(evt.id, { messageId, req: evt });
    } catch (err) {
      // The adapter's own timeout still resolves the park; losing the card
      // only loses the approve path, never hangs the run.
      log.fail('approval-card', err, { step: 'send', id: evt.id });
    }
  }

  async onResolved(evt: PermissionResolved): Promise<void> {
    const entry = this.open.get(evt.id);
    if (!entry) return;
    this.open.delete(evt.id);
    const outcome: ApprovalOutcome =
      evt.reason === 'timeout'
        ? 'timeout'
        : evt.reason === 'aborted'
          ? 'run_ended'
          : evt.decision === 'allow'
            ? 'allowed'
            : 'denied';
    await this.updateSafe(entry, outcome);
  }

  async sweep(): Promise<void> {
    const entries = [...this.open.values()];
    this.open.clear();
    for (const entry of entries) {
      await this.updateSafe(entry, 'run_ended');
    }
  }

  private async updateSafe(entry: OpenEntry, outcome: ApprovalOutcome): Promise<void> {
    try {
      await this.io.update(entry.messageId, renderApprovalCard(entry.req, { kind: 'resolved', outcome }));
    } catch (err) {
      log.fail('approval-card', err, { step: 'update', id: entry.req.id, outcome });
    }
  }
}
