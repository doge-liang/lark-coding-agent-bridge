import { formatElapsedDuration, type Block, type RunState, type ToolEntry } from './run-state';
import { toolHeaderText } from './tool-render';

const MARKDOWN_STREAM_MAX_CHARS = 24_000;
const OMITTED_OLDER_CONTENT = '_已省略较早的流式内容，保留最近输出。_';

/**
 * Render `RunState` as plain markdown text — used in `messageReply: 'text'`
 * mode where we stream a markdown message instead of a card.
 *
 * Differences vs `renderCard`:
 *   - No collapsible panels, no buttons (markdown messages have neither)
 *   - Tool calls collapse to a single short line each (no body)
 *   - No reasoning / thinking output (no place to fold it; would be noise)
 *   - Footer is appended inline at the bottom while running
 */
export function renderText(state: RunState): string {
  const parts: string[] = [];

  for (const block of state.blocks) {
    const piece = renderBlock(block);
    if (piece) parts.push(piece);
  }

  if (state.terminal === 'interrupted') {
    parts.push('_⏹ 已被中断_');
  } else if (state.terminal === 'idle_timeout') {
    const mins = state.idleTimeoutMinutes ?? 0;
    parts.push(`_⏱ ${mins} 分钟无响应,已自动终止_`);
  } else if (state.terminal === 'error' && state.errorMsg) {
    parts.push(`⚠️ agent 失败:${state.errorMsg}`);
  } else if (state.terminal === 'running' && state.footer) {
    parts.push(footerLine(state.footer, state.toolElapsedMs));
  }

  return fitMarkdown(parts);
}

function renderBlock(block: Block): string {
  if (block.kind === 'text') {
    return block.content.trim();
  }
  return toolLine(block.tool);
}

/**
 * One-line summary for a tool call:
 *   `> ⏳ **Bash** — git status`
 *   `> ✅ **Read** — ~/code/foo.ts`
 * Reuses `toolHeaderText` so the format matches the card mode header.
 */
function toolLine(tool: ToolEntry): string {
  return `> ${toolHeaderText(tool)}`;
}

function footerLine(
  status: 'thinking' | 'tool_running' | 'streaming',
  toolElapsedMs?: number,
): string {
  if (status === 'thinking') return '_🧠 正在思考…_';
  if (status === 'tool_running') {
    const elapsed = toolElapsedMs ? ` 已运行 ${formatElapsedDuration(toolElapsedMs)}` : '';
    return `_🧰 正在调用工具…${elapsed}_`;
  }
  return '_✍️ 正在输出…_';
}

function fitMarkdown(parts: string[]): string {
  const full = joinParts(parts);
  if (full.length <= MARKDOWN_STREAM_MAX_CHARS) return full;

  const kept: string[] = [];
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (!part) continue;
    const candidate = joinParts([OMITTED_OLDER_CONTENT, part, ...kept]);
    if (candidate.length <= MARKDOWN_STREAM_MAX_CHARS) {
      kept.unshift(part);
      continue;
    }

    const current = joinParts([OMITTED_OLDER_CONTENT, ...kept]);
    const budget = MARKDOWN_STREAM_MAX_CHARS - current.length - 2;
    if (budget > 20) kept.unshift(tailMarkdown(part, budget));
    break;
  }

  return joinParts([OMITTED_OLDER_CONTENT, ...kept]);
}

function tailMarkdown(part: string, budget: number): string {
  if (part.length <= budget) return part;
  if (budget <= 1) return '…';
  return `…${part.slice(-(budget - 1))}`;
}

function joinParts(parts: string[]): string {
  return parts.filter((part) => part.length > 0).join('\n\n');
}
