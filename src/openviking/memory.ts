import type { AgentEvent } from '../agent/types';
import { log, reportMetric } from '../core/logger';
import { OpenVikingClient, type OpenVikingMessage } from './client';

/**
 * Unified long-term memory across agent backends (claude / codex), backed by
 * a local OpenViking server. Two touch points, both agent-agnostic:
 *
 * - `augmentPrompt`: before a run, retrieve L0/L1 memories relevant to the
 *   prompt and prepend them as a clearly-framed context block. Strictly
 *   fail-open — any error or timeout returns the original prompt untouched,
 *   so a down/unconfigured OpenViking never blocks a run.
 * - `observeRun`: subscribe to the run's event stream as an independent
 *   fanout consumer, accumulate the assistant's text, and after a normal
 *   completion push the exchange into an OpenViking session + commit (which
 *   triggers server-side async memory extraction). Fire-and-forget.
 *
 * Settings are read through `getSettings` on every call so the `/ov memory
 * on|off` toggle takes effect immediately without a restart.
 */

export interface OpenVikingMemorySettings {
  memoryEnabled: boolean;
  serverUrl: string;
}

export interface ObserveRunInput {
  scopeId: string;
  prompt: string;
  events: AsyncIterable<AgentEvent>;
}

export interface OpenVikingMemory {
  augmentPrompt(scopeId: string, prompt: string): Promise<string>;
  observeRun(input: ObserveRunInput): void;
}

/** Slice of the client the memory layer uses; narrowed for test stubs. */
export type MemoryClient = Pick<
  OpenVikingClient,
  'find' | 'ensureSession' | 'addMessages' | 'commitSession'
>;

const FIND_TIMEOUT_MS = 2500;
// Query = tail of the built prompt: the newest user message sits at the end,
// and embedding queries degrade with the scaffolding that precedes it.
const QUERY_MAX_CHARS = 600;
const MAX_HITS = 6;
const HIT_MAX_CHARS = 300;
// Per-message cap when recording. Bounds the VLM extraction cost per commit;
// long tool-heavy answers get their head kept (conclusions usually lead).
const RECORD_MAX_CHARS = 20_000;

export function createOpenVikingMemory(
  getSettings: () => OpenVikingMemorySettings,
  createClient: (serverUrl: string) => MemoryClient = (url) => new OpenVikingClient(url),
): OpenVikingMemory {
  return {
    async augmentPrompt(scopeId: string, prompt: string): Promise<string> {
      const settings = getSettings();
      if (!settings.memoryEnabled) return prompt;
      try {
        const hits = await createClient(settings.serverUrl).find({
          query: prompt.slice(-QUERY_MAX_CHARS),
          contextType: 'memory',
          level: '0,1',
          nodeLimit: MAX_HITS,
          timeoutMs: FIND_TIMEOUT_MS,
        });
        const lines = hits
          .map((hit) => (hit.overview ?? hit.abstract ?? '').trim())
          .filter(Boolean)
          .map((text) => `- ${text.slice(0, HIT_MAX_CHARS)}`);
        if (lines.length === 0) return prompt;
        log.info('openviking', 'memory-injected', { scope: scopeId, hits: lines.length });
        return [
          '以下是与本次请求可能相关的长期记忆（来自历史会话，仅供参考；若与当前指令冲突，以当前指令为准）：',
          ...lines,
          '——长期记忆结束——',
          '',
          prompt,
        ].join('\n');
      } catch (err) {
        log.warn('openviking', 'find-failed', {
          scope: scopeId,
          err: err instanceof Error ? err.message : String(err),
        });
        reportMetric('openviking_fail', 1, { step: 'find' });
        return prompt;
      }
    },

    observeRun(input: ObserveRunInput): void {
      if (!getSettings().memoryEnabled) return;
      void (async () => {
        let text = '';
        let termination: string | undefined;
        for await (const event of input.events) {
          if (event.type === 'text') text += event.delta;
          else if (event.type === 'done') termination = event.terminationReason;
          else if (event.type === 'error') termination = event.terminationReason;
        }
        // Interrupted / failed runs produce partial answers — recording them
        // would seed the memory store with half-truths.
        if (termination !== 'normal' || !text.trim()) return;
        const settings = getSettings();
        if (!settings.memoryEnabled) return;
        const client = createClient(settings.serverUrl);
        const sessionId = memorySessionId(input.scopeId);
        const messages: OpenVikingMessage[] = [
          { role: 'user', content: input.prompt.slice(0, RECORD_MAX_CHARS) },
          { role: 'assistant', content: text.slice(0, RECORD_MAX_CHARS) },
        ];
        await client.ensureSession(sessionId);
        await client.addMessages(sessionId, messages);
        await client.commitSession(sessionId);
        log.info('openviking', 'run-recorded', {
          scope: input.scopeId,
          promptChars: messages[0]!.content.length,
          replyChars: messages[1]!.content.length,
        });
      })().catch((err) => {
        log.warn('openviking', 'record-failed', {
          scope: input.scopeId,
          err: err instanceof Error ? err.message : String(err),
        });
        reportMetric('openviking_fail', 1, { step: 'record' });
      });
    },
  };
}

/** One OpenViking session per bridge scope, so multi-turn chats accumulate. */
export function memorySessionId(scopeId: string): string {
  return `lark-${scopeId.replace(/[^A-Za-z0-9._-]/g, '-')}`;
}
