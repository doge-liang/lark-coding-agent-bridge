import { describe, expect, it } from 'vitest';
import { translateSdkMessage } from '../../../src/agent/claude/sdk-translate.js';

const streamDelta = (delta: unknown) => ({
  type: 'stream_event',
  event: { type: 'content_block_delta', delta },
});

describe('translateSdkMessage streaming mode', () => {
  it('emits incremental text from text_delta stream_events', () => {
    const out = translateSdkMessage(streamDelta({ type: 'text_delta', text: 'Hel' }), {
      streaming: true,
    });
    expect(out).toEqual([{ type: 'text', delta: 'Hel' }]);
  });

  it('emits incremental thinking from thinking_delta stream_events', () => {
    const out = translateSdkMessage(streamDelta({ type: 'thinking_delta', thinking: 'hmm' }), {
      streaming: true,
    });
    expect(out).toEqual([{ type: 'thinking', delta: 'hmm' }]);
  });

  it('ignores stream_events when streaming is off (no partials expected)', () => {
    expect(translateSdkMessage(streamDelta({ type: 'text_delta', text: 'x' }))).toEqual([]);
  });

  it('suppresses text/thinking on the final assistant frame in streaming mode but keeps tool_use', () => {
    const assistant = {
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'reasoned' },
          { type: 'text', text: 'the full answer' },
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    };
    const out = translateSdkMessage(assistant, { streaming: true });
    expect(out).toEqual([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }]);
  });

  it('keeps the full assistant frame text when streaming is off (unchanged behavior)', () => {
    const assistant = {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'the full answer' }] },
    };
    const out = translateSdkMessage(assistant);
    expect(out).toEqual([{ type: 'text', delta: 'the full answer' }]);
  });

  it('still surfaces assistant-frame errors in streaming mode', () => {
    const out = translateSdkMessage({ type: 'assistant', error: 'overloaded' }, { streaming: true });
    expect(out).toEqual([
      { type: 'error', message: 'claude error: overloaded', terminationReason: 'failed' },
    ]);
  });
});
