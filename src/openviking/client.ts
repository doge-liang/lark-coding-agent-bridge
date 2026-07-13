/**
 * Minimal HTTP client for a local OpenViking server (context database).
 * OpenViking has no official Node SDK; the server speaks plain JSON over
 * HTTP (default http://127.0.0.1:1933), so we call the handful of endpoints
 * the bridge needs directly. All responses use the `{status:'ok', result}`
 * envelope; anything else is thrown for the caller to log.
 */

export interface OpenVikingFindOptions {
  query: string;
  /** e.g. 'memory' to search only extracted memories. */
  contextType?: string | string[];
  targetUri?: string | string[];
  /** Comma-separated LOD levels, e.g. '0,1' (L0 abstract + L1 overview). */
  level?: string;
  nodeLimit?: number;
  scoreThreshold?: number;
  timeoutMs?: number;
}

export interface OpenVikingHit {
  uri: string;
  contextType?: string;
  level?: number;
  score?: number;
  abstract?: string;
  overview?: string | null;
}

export interface OpenVikingMessage {
  role: 'user' | 'assistant';
  content: string;
}

const DEFAULT_TIMEOUT_MS = 5000;

export class OpenVikingClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(baseUrl: string, opts: { timeoutMs?: number } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async health(timeoutMs = 1500): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Pure vector search (`/search/find`) — no session/intent expansion, cheap. */
  async find(opts: OpenVikingFindOptions): Promise<OpenVikingHit[]> {
    const result = (await this.request(
      'POST',
      '/api/v1/search/find',
      {
        query: opts.query,
        ...(opts.contextType ? { context_type: opts.contextType } : {}),
        ...(opts.targetUri ? { target_uri: opts.targetUri } : {}),
        ...(opts.level ? { level: opts.level } : {}),
        ...(opts.nodeLimit ? { node_limit: opts.nodeLimit } : {}),
        ...(opts.scoreThreshold !== undefined ? { score_threshold: opts.scoreThreshold } : {}),
      },
      opts.timeoutMs,
    )) as {
      memories?: RawHit[];
      resources?: RawHit[];
      skills?: RawHit[];
    };
    const raw = [
      ...(result.memories ?? []),
      ...(result.resources ?? []),
      ...(result.skills ?? []),
    ];
    return raw.map((hit) => ({
      uri: hit.uri,
      contextType: hit.context_type,
      level: hit.level,
      score: hit.score,
      abstract: hit.abstract,
      overview: hit.overview,
    }));
  }

  /** Idempotent session ensure — GET with auto_create creates on first touch. */
  async ensureSession(sessionId: string): Promise<void> {
    await this.request(
      'GET',
      `/api/v1/sessions/${encodeURIComponent(sessionId)}?auto_create=true`,
    );
  }

  async addMessages(sessionId: string, messages: OpenVikingMessage[]): Promise<void> {
    await this.request(
      'POST',
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/messages/batch`,
      { messages },
    );
  }

  /**
   * Commit the session: archives accumulated messages and kicks off the
   * server-side (async) memory-extraction task. Returns immediately; the
   * extraction runs in the OpenViking task queue.
   */
  async commitSession(sessionId: string): Promise<void> {
    await this.request(
      'POST',
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/commit`,
      {},
    );
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs?: number,
  ): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      ...(body !== undefined
        ? {
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }
        : {}),
      signal: AbortSignal.timeout(timeoutMs ?? this.timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`openviking ${method} ${path} → HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    let payload: { status?: string; result?: unknown; message?: string };
    try {
      payload = JSON.parse(text) as typeof payload;
    } catch {
      throw new Error(`openviking ${method} ${path} → invalid JSON: ${text.slice(0, 200)}`);
    }
    if (payload.status && payload.status !== 'ok') {
      throw new Error(
        `openviking ${method} ${path} → status ${payload.status}: ${payload.message ?? ''}`,
      );
    }
    return payload.result ?? payload;
  }
}

interface RawHit {
  uri: string;
  context_type?: string;
  level?: number;
  score?: number;
  abstract?: string;
  overview?: string | null;
}
