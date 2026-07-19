import type { BgCardView } from '../bot/background-run-manager';
import type { BgTaskStatus } from '../session/bg-tasks-store';

/**
 * Renders a `/bg` background task's own card (CardKit 2.0). The stop button
 * follows the same signed-callback convention as the foreground run card
 * (see run-renderer.ts): the wiring layer supplies `signCallback`, which mints
 * the `bridge_token` the dispatcher verifies before acting on the click.
 */

export interface BgTaskCardOptions {
  /** Mints a bridge callback token for an action; omit for a display-only card. */
  signCallback?: (action: string) => string;
}

const STATUS_LABEL: Record<BgTaskStatus, string> = {
  running: '🟢 运行中',
  resuming: '🔄 重启恢复中',
  done: '✅ 已完成',
  error: '❌ 出错',
  interrupted: '⏹ 已停止',
};

const PROMPT_MAX = 300;
const TEXT_MAX = 1500;

function isActive(status: BgTaskStatus): boolean {
  return status === 'running' || status === 'resuming';
}

export function renderBgTaskCard(view: BgCardView, options: BgTaskCardOptions = {}): object {
  const { task, progress, text } = view;
  const statusLabel = STATUS_LABEL[task.status] ?? task.status;
  const elements: object[] = [
    { tag: 'markdown', content: `🤖 **后台任务** \`${task.taskId}\`\n\n状态：${statusLabel}` },
    {
      tag: 'markdown',
      content: `**任务**\n${truncate(task.prompt, PROMPT_MAX)}`,
      text_size: 'notation',
    },
  ];
  if (progress && isActive(task.status)) {
    elements.push({ tag: 'markdown', content: `⏳ ${progress}`, text_size: 'notation' });
  }
  const body = text.trim();
  if (body) {
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'markdown', content: truncate(body, TEXT_MAX) });
  }
  if (isActive(task.status)) {
    // A signed callback button when the caller can mint a token; otherwise a
    // text hint pointing at the always-available `/bg stop` command (a
    // token-less button would be rejected on click).
    elements.push(
      options.signCallback
        ? stopButton(task.taskId, options)
        : {
            tag: 'markdown',
            content: `_发送 \`/bg stop ${task.taskId}\` 可停止此任务_`,
            text_size: 'notation',
          },
    );
  }
  return {
    schema: '2.0',
    config: { summary: { content: `后台任务 ${task.taskId} · ${statusLabel}` } },
    body: { elements },
  };
}

function stopButton(taskId: string, options: BgTaskCardOptions): object {
  const value: Record<string, unknown> = { cmd: 'bg.stop', taskId };
  if (options.signCallback) {
    value.__bridge_cb = true;
    value.bridge_token = options.signCallback(`bg.stop:${taskId}`);
  }
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: '⏹ 停止任务' },
    type: 'danger',
    behaviors: [{ type: 'callback', value }],
  };
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}
