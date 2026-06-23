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

    const response = await this.fetchImpl('https://api.x.com/2/tweets', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.options.bearerToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ text: input.text }),
    });

    if (!response.ok) {
      const status = response.status === 429 || response.status >= 500 ? 'retryable-error' : 'terminal-error';
      return {
        status,
        postKey: input.postKey,
        message: `X API ${response.status}`,
      };
    }

    const json = (await response.json()) as { data?: { id?: string } };
    const xPostId = json.data?.id;
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
