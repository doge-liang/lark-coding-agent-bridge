import { describe, expect, it, vi } from 'vitest';
import { XApiAdapter } from '../../../src/bunny/x-api';

describe('XApiAdapter', () => {
  it('returns dry-run result when live publishing is disabled', async () => {
    const fetchImpl = vi.fn();
    const adapter = new XApiAdapter({
      livePublishing: false,
      fetchImpl,
    });

    await expect(adapter.publish({
      postKey: 'post-key',
      text: 'AI workflow post',
    })).resolves.toEqual({
      status: 'dry-run',
      postKey: 'post-key',
      message: 'live publishing disabled',
    });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('posts to X API when live publishing is enabled', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: { id: '12345' } }), { status: 201 }));
    const adapter = new XApiAdapter({
      livePublishing: true,
      bearerToken: 'token',
      fetchImpl,
    });

    await expect(adapter.publish({
      postKey: 'post-key',
      text: 'AI workflow post',
    })).resolves.toEqual({
      status: 'published',
      postKey: 'post-key',
      xPostId: '12345',
      xPostUrl: 'https://x.com/i/web/status/12345',
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.x.com/2/tweets',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer token',
          'content-type': 'application/json',
        }),
        body: JSON.stringify({ text: 'AI workflow post' }),
      }),
    );
  });

  it('trims whitespace from returned X post id', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: { id: ' 12345 ' } }), { status: 201 }));
    const adapter = new XApiAdapter({
      livePublishing: true,
      bearerToken: 'token',
      fetchImpl,
    });

    await expect(adapter.publish({
      postKey: 'post-key',
      text: 'AI workflow post',
    })).resolves.toEqual({
      status: 'published',
      postKey: 'post-key',
      xPostId: '12345',
      xPostUrl: 'https://x.com/i/web/status/12345',
    });
  });

  it('classifies API errors without leaking tokens', async () => {
    const fetchImpl = vi.fn(async () => new Response('rate limit', { status: 429 }));
    const adapter = new XApiAdapter({
      livePublishing: true,
      bearerToken: 'secret-token',
      fetchImpl,
    });

    const result = await adapter.publish({
      postKey: 'post-key',
      text: 'AI workflow post',
    });

    if (result.status === 'retryable-error') {
      expect(result).toEqual({
        status: 'retryable-error',
        postKey: 'post-key',
        message: 'X API 429',
      });
      expect(result.message).not.toContain('secret-token');
      return;
    }

    expect.fail('Expected retryable error result');
  });

  it('returns retryable error when fetch fails', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('temporary network issue');
    });
    const adapter = new XApiAdapter({
      livePublishing: true,
      bearerToken: 'secret-token',
      fetchImpl,
    });

    const result = await adapter.publish({
      postKey: 'post-key',
      text: 'AI workflow post',
    });

    if (result.status === 'retryable-error') {
      expect(result).toEqual({
        status: 'retryable-error',
        postKey: 'post-key',
        message: 'X API network error',
      });
      expect(result.message).not.toContain('secret-token');
      return;
    }

    expect.fail('Expected retryable network error result');
  });

  it('returns terminal error when response body is not valid JSON', async () => {
    const fetchImpl = vi.fn(async () => new Response('{invalid-json', { status: 201 }));
    const adapter = new XApiAdapter({
      livePublishing: true,
      bearerToken: 'token',
      fetchImpl,
    });

    const result = await adapter.publish({
      postKey: 'post-key',
      text: 'AI workflow post',
    });

    expect(result).toEqual({
      status: 'terminal-error',
      postKey: 'post-key',
      message: 'X API response invalid JSON',
    });
  });

  it('returns terminal error when X response data.id is missing or invalid', async () => {
    const invalidPayloads: Array<[string, unknown]> = [
      ['missing data', {}],
      ['null data', { data: null }],
      ['missing id', { data: {} }],
      ['non-string id', { data: { id: 123 } }],
      ['empty id', { data: { id: '' } }],
      ['blank id', { data: { id: '   ' } }],
    ];

    for (const [label, payload] of invalidPayloads) {
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify(payload), { status: 201 }));
      const adapter = new XApiAdapter({
        livePublishing: true,
        bearerToken: 'token',
        fetchImpl,
      });

      const result = await adapter.publish({
        postKey: 'post-key',
        text: 'AI workflow post',
      });

      expect(result, label).toEqual({
        status: 'terminal-error',
        postKey: 'post-key',
        message: 'X API response missing post id',
      });
    }
  });
});
