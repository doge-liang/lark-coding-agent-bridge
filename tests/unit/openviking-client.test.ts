import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenVikingClient } from '../../src/openviking/client.js';

interface CapturedRequest {
  method: string;
  url: string;
  body: unknown;
}

let server: Server | undefined;

async function startServer(
  handler: (req: CapturedRequest, res: ServerResponse) => void,
): Promise<{ baseUrl: string; requests: CapturedRequest[] }> {
  const requests: CapturedRequest[] = [];
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const captured: CapturedRequest = {
        method: req.method ?? '',
        url: req.url ?? '',
        body: raw ? JSON.parse(raw) : undefined,
      };
      requests.push(captured);
      handler(captured, res);
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address !== 'object' || !address) throw new Error('no server address');
  return { baseUrl: `http://127.0.0.1:${address.port}`, requests };
}

function respond(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

describe('OpenVikingClient', () => {
  it('maps find hits across memories/resources and sends snake_case fields', async () => {
    const { baseUrl, requests } = await startServer((_req, res) =>
      respond(res, 200, {
        status: 'ok',
        result: {
          memories: [
            { uri: 'viking://user/memories/a', context_type: 'memory', level: 0, abstract: 'A' },
          ],
          resources: [{ uri: 'viking://resources/b', context_type: 'resource', overview: 'B' }],
        },
      }),
    );
    const hits = await new OpenVikingClient(baseUrl).find({
      query: 'q',
      contextType: 'memory',
      level: '0,1',
      nodeLimit: 6,
    });
    expect(hits.map((hit) => hit.uri)).toEqual(['viking://user/memories/a', 'viking://resources/b']);
    expect(hits[0]).toMatchObject({ contextType: 'memory', abstract: 'A' });
    expect(requests[0]).toMatchObject({
      method: 'POST',
      url: '/api/v1/search/find',
      body: { query: 'q', context_type: 'memory', level: '0,1', node_limit: 6 },
    });
  });

  it('drives the session lifecycle endpoints', async () => {
    const { baseUrl, requests } = await startServer((_req, res) =>
      respond(res, 200, { status: 'ok', result: {} }),
    );
    const client = new OpenVikingClient(baseUrl);
    await client.ensureSession('lark-chat:1');
    await client.addMessages('lark-chat:1', [{ role: 'user', content: 'hi' }]);
    await client.commitSession('lark-chat:1');
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      'GET /api/v1/sessions/lark-chat%3A1?auto_create=true',
      'POST /api/v1/sessions/lark-chat%3A1/messages/batch',
      'POST /api/v1/sessions/lark-chat%3A1/commit',
    ]);
    expect(requests[1]!.body).toEqual({ messages: [{ role: 'user', content: 'hi' }] });
  });

  it('throws on HTTP errors and non-ok envelopes', async () => {
    const { baseUrl } = await startServer((req, res) => {
      if (req.url.includes('boom')) respond(res, 500, { detail: 'kaput' });
      else respond(res, 200, { status: 'error', message: 'bad target' });
    });
    const client = new OpenVikingClient(baseUrl);
    await expect(client.ensureSession('boom')).rejects.toThrow('HTTP 500');
    await expect(client.find({ query: 'q' })).rejects.toThrow('bad target');
  });
});
