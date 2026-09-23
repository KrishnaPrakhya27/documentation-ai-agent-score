import http from 'http';
import type { AddressInfo } from 'net';

import { assertFetchableUrl } from '../transport/publicAddress';

/**
 * A throwaway HTTP site on 127.0.0.1 for scanner tests. Routes are keyed by
 * path (with query); each hit is recorded with its arrival time so tests can
 * assert on spacing, retries and caching.
 */

export interface FixtureReply {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Buffer;
  delayMs?: number;
}

export type FixtureRoute =
  | FixtureReply
  | ((request: http.IncomingMessage, hitCount: number) => FixtureReply);

export interface FixtureHit {
  path: string;
  method: string;
  at: number;
  headers: http.IncomingHttpHeaders;
}

export interface FixtureSite {
  origin: string;
  hits: FixtureHit[];
  hitsFor(path: string): FixtureHit[];
  close(): Promise<void>;
}

export async function startFixtureSite(
  routes: Record<string, FixtureRoute>,
): Promise<FixtureSite> {
  const hits: FixtureHit[] = [];
  const server = http.createServer((request, response) => {
    const path = request.url ?? '/';
    hits.push({
      path,
      method: request.method ?? 'GET',
      at: Date.now(),
      headers: request.headers,
    });
    const route = routes[path] ?? routes[path.split('?')[0]];
    const count = hits.filter((hit) => hit.path === path).length;
    const reply: FixtureReply = !route
      ? { status: 404, body: 'not found' }
      : typeof route === 'function'
        ? route(request, count)
        : route;

    const send = () => {
      response.writeHead(reply.status ?? 200, {
        'content-type': 'text/html; charset=utf-8',
        ...reply.headers,
      });
      response.end(request.method === 'HEAD' ? undefined : reply.body ?? '');
    };
    if (reply.delayMs) setTimeout(send, reply.delayMs);
    else send();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;

  return {
    origin,
    hits,
    hitsFor: (path) => hits.filter((hit) => hit.path === path),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Lets the fixture origin through while every other URL meets the real guard. */
export function allowOnly(origin: string) {
  return (raw: string | URL): URL => {
    const url = typeof raw === 'string' ? new URL(raw) : raw;
    if (url.origin === origin) return url;
    return assertFetchableUrl(url);
  };
}
