export type XPublishResult =
  | { status: 'dry-run'; postKey: string; message: string }
  | { status: 'published'; postKey: string; xPostId: string; xPostUrl: string }
  | { status: 'retryable-error' | 'terminal-error'; postKey: string; message: string };

export interface XApiAdapterOptions {
  livePublishing: boolean;
  bearerToken?: string;
  fetchImpl?: typeof fetch;
}

export interface XPublishInput {
  postKey: string;
  text: string;
}

export class XApiAdapter {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: XApiAdapterOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async publish(input: XPublishInput): Promise<XPublishResult> {
    if (!this.options.livePublishing) {
      return {
        status: 'dry-run',
        postKey: input.postKey,
        message: 'live publishing disabled',
      };
    }

    if (!this.options.bearerToken) {
      return {
        status: 'terminal-error',
        postKey: input.postKey,
        message: 'missing X bearer token',
      };
    }

    let response: Response;
    try {
      response = await this.fetchImpl('https://api.x.com/2/tweets', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.bearerToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ text: input.text }),
      });
    } catch {
      return {
        status: 'retryable-error',
        postKey: input.postKey,
        message: 'X API network error',
      };
    }

    if (!response.ok) {
      const status = response.status === 429 || response.status >= 500 ? 'retryable-error' : 'terminal-error';
      return {
        status,
        postKey: input.postKey,
        message: `X API ${response.status}`,
      };
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      return {
        status: 'terminal-error',
        postKey: input.postKey,
        message: 'X API response invalid JSON',
      };
    }

    if (
      typeof json !== 'object' ||
      json === null ||
      typeof (json as { data?: unknown }).data !== 'object' ||
      (json as { data?: unknown }).data === null
    ) {
      return {
        status: 'terminal-error',
        postKey: input.postKey,
        message: 'X API response missing post id',
      };
    }

    const data = (json as { data?: { id?: unknown } }).data;
    const xPostId = typeof data?.id === 'string' && data.id.trim().length > 0 ? data.id : undefined;
    if (!xPostId) {
      return {
        status: 'terminal-error',
        postKey: input.postKey,
        message: 'X API response missing post id',
      };
    }

    return {
      status: 'published',
      postKey: input.postKey,
      xPostId,
      xPostUrl: `https://x.com/i/web/status/${xPostId}`,
    };
  }
}
