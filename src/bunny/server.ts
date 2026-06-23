import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { BunnyEngine } from './engine';

export interface StartBunnyServerOptions {
  engine: BunnyEngine;
  host: string;
  port: number;
}

export interface BunnyServerHandle {
  port: number;
  close(): Promise<void>;
}

export async function startBunnyServer(options: StartBunnyServerOptions): Promise<BunnyServerHandle> {
  const server = createServer((request, response) => {
    void handleRequest(options.engine, request, response).catch((err: unknown) => {
      writeJson(response, 500, {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;

  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      }),
  };
}

async function handleRequest(
  engine: BunnyEngine,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const method = request.method ?? 'GET';

  if (method === 'GET' && url.pathname === '/status') {
    writeJson(response, 200, engine.status());
    return;
  }

  if (method === 'GET' && url.pathname === '/today') {
    writeJson(response, 200, engine.today());
    return;
  }

  if (method === 'POST' && url.pathname === '/pause') {
    engine.pause();
    writeJson(response, 200, { ok: true, paused: true });
    return;
  }

  if (method === 'POST' && url.pathname === '/resume') {
    engine.resume();
    writeJson(response, 200, { ok: true, paused: false });
    return;
  }

  if (method === 'POST' && url.pathname === '/run-once') {
    writeJson(response, 200, await engine.runOnce());
    return;
  }

  if (method === 'POST' && url.pathname === '/publish-due') {
    writeJson(response, 200, await engine.publishDue());
    return;
  }

  writeJson(response, 404, { error: 'not found' });
}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  if (response.headersSent) return;
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  response.end(`${JSON.stringify(payload)}\n`);
}
