import { afterEach, describe, expect, it } from 'vitest';

import {
  RequestBudgetError,
  RobotsDisallowedError,
  TooManyRedirectsError,
} from '../transport/errors';
import {
  GuardedFetcher,
  retryAfterMs,
  type GuardedFetcherOptions,
} from '../transport/guardedFetch';
import { BlockedTargetError } from '../transport/publicAddress';
import {
  allowOnly,
  startFixtureSite,
  type FixtureRoute,
  type FixtureSite,
} from './fixtureServer';

/**
 * The guarded fetcher against a real local HTTP server: robots.txt, redirects
 * (including one that points into a private network), spacing, Retry-After,
 * byte and request caps, and the per-scan cache.
 */

let site: FixtureSite | undefined;
let fetcher: GuardedFetcher | undefined;

afterEach(async () => {
  await fetcher?.close();
  await site?.close();
  fetcher = undefined;
  site = undefined;
});

async function setUp(
  routes: Record<string, FixtureRoute>,
  overrides: Partial<GuardedFetcherOptions> = {},
) {
  site = await startFixtureSite(routes);
  fetcher = new GuardedFetcher({
    userAgent: 'Mozilla/5.0 (compatible; DocumentationAI-AgentScore/1.0)',
    robotsToken: 'DocumentationAI-AgentScore',
    requestTimeoutMs: 2_000,
    maxBodyBytes: 1024 * 1024,
    maxRedirects: 3,
    minIntervalMs: 0,
    maxConcurrentPerOrigin: 3,
    maxRequests: 50,
    maxRetryAfterMs: 2_000,
    validateUrl: allowOnly(site.origin),
    isAllowedAddress: () => true,
    ...overrides,
  });
  return { site, fetcher };
}

describe('robots.txt', () => {
  it('refuses a disallowed path and fetches an allowed one', async () => {
    const { site, fetcher } = await setUp({
      '/robots.txt': {
        headers: { 'content-type': 'text/plain' },
        body: 'User-agent: *\nDisallow: /private\nAllow: /private/public',
      },
      '/private/page': { body: 'secret' },
      '/private/public/page': { body: 'fine' },
    });

    await expect(fetcher.fetch(`${site.origin}/private/page`)).rejects.toBeInstanceOf(
      RobotsDisallowedError,
    );
    const allowed = await fetcher.fetch(`${site.origin}/private/public/page`);
    expect(await allowed.text()).toBe('fine');
    expect(site.hitsFor('/private/page')).toHaveLength(0);
    expect(site.hitsFor('/robots.txt')).toHaveLength(1);
  });

  it('obeys a group written for our own token', async () => {
    const { site, fetcher } = await setUp({
      '/robots.txt': {
        headers: { 'content-type': 'text/plain' },
        body: 'User-agent: DocumentationAI-AgentScore\nDisallow: /\n\nUser-agent: *\nAllow: /',
      },
      '/docs': { body: 'docs' },
    });
    await expect(fetcher.fetch(`${site.origin}/docs`)).rejects.toBeInstanceOf(
      RobotsDisallowedError,
    );
  });

  it('treats a missing robots.txt as allow-all and a server error as disallow', async () => {
    const { site, fetcher } = await setUp({ '/docs': { body: 'docs' } });
    expect((await fetcher.fetch(`${site.origin}/docs`)).status).toBe(200);

    await fetcher.close();
    await site.close();
    const second = await setUp({
      '/robots.txt': { status: 500, body: 'oops' },
      '/docs': { body: 'docs' },
    });
    await expect(second.fetcher.fetch(`${second.site.origin}/docs`)).rejects.toBeInstanceOf(
      RobotsDisallowedError,
    );
  });

  it('spaces requests by the Crawl-delay', async () => {
    const { site, fetcher } = await setUp({
      '/robots.txt': {
        headers: { 'content-type': 'text/plain' },
        body: 'User-agent: *\nCrawl-delay: 0.3',
      },
      '/a': { body: 'a' },
      '/b': { body: 'b' },
    });
    await Promise.all([
      fetcher.fetch(`${site.origin}/a`),
      fetcher.fetch(`${site.origin}/b`),
    ]);
    const [first, second] = [site.hitsFor('/a')[0], site.hitsFor('/b')[0]].sort(
      (x, y) => x.at - y.at,
    );
    expect(second.at - first.at).toBeGreaterThanOrEqual(280);
  });
});

describe('redirects', () => {
  it('follows redirects and reports where it landed', async () => {
    const { site, fetcher } = await setUp({
      '/old': { status: 301, headers: { location: '/new' } },
      '/new': { body: 'moved here' },
    });
    const response = await fetcher.fetch(`${site.origin}/old`);
    expect(response.url).toBe(`${site.origin}/new`);
    expect(response.redirected).toBe(true);
    expect(await response.text()).toBe('moved here');
  });

  it('refuses a redirect into a private network', async () => {
    const { site, fetcher } = await setUp({
      '/escape': {
        status: 302,
        headers: { location: 'http://10.0.0.1/admin' },
      },
    });
    await expect(fetcher.fetch(`${site.origin}/escape`)).rejects.toBeInstanceOf(
      BlockedTargetError,
    );
  });

  it('stops after the redirect limit', async () => {
    const { site, fetcher } = await setUp({
      '/loop': { status: 302, headers: { location: '/loop' } },
    });
    await expect(fetcher.fetch(`${site.origin}/loop`)).rejects.toBeInstanceOf(
      TooManyRedirectsError,
    );
  });

  it('returns the redirect itself in manual mode', async () => {
    const { site, fetcher } = await setUp({
      '/old': { status: 308, headers: { location: '/new' } },
    });
    const response = await fetcher.fetch(`${site.origin}/old`, {
      redirect: 'manual',
    });
    expect(response.status).toBe(308);
    expect(response.headers.get('location')).toBe('/new');
  });
});

describe('limits', () => {
  it('cuts a body at the byte cap', async () => {
    const { site, fetcher } = await setUp(
      { '/big': { body: 'x'.repeat(10_000) } },
      { maxBodyBytes: 1_000 },
    );
    const response = await fetcher.fetch(`${site.origin}/big`);
    expect((await response.text()).length).toBe(1_000);
    expect(response.truncated).toBe(true);
  });

  it('stops at the request budget', async () => {
    const { site, fetcher } = await setUp(
      { '/a': { body: 'a' }, '/b': { body: 'b' } },
      { maxRequests: 2 },
    );
    await fetcher.fetch(`${site.origin}/a`);
    await expect(fetcher.fetch(`${site.origin}/b`)).rejects.toBeInstanceOf(
      RequestBudgetError,
    );
  });

  it('keeps request starts to one origin apart', async () => {
    const { site, fetcher } = await setUp(
      { '/a': { body: 'a' }, '/b': { body: 'b' }, '/c': { body: 'c' } },
      { minIntervalMs: 150 },
    );
    await Promise.all(
      ['/a', '/b', '/c'].map((path) => fetcher.fetch(`${site.origin}${path}`)),
    );
    const starts = ['/a', '/b', '/c']
      .map((path) => site.hitsFor(path)[0].at)
      .sort((x, y) => x - y);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(130);
    expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(130);
  });

  it('waits out a short Retry-After and tries again', async () => {
    const { site, fetcher } = await setUp({
      '/busy': (_request, hit) =>
        hit === 1
          ? { status: 429, headers: { 'retry-after': '1' } }
          : { body: 'ready' },
    });
    const response = await fetcher.fetch(`${site.origin}/busy`);
    expect(await response.text()).toBe('ready');
    expect(fetcher.stats().retryAfterWaits).toBe(1);
  });

  it('gives up on a long Retry-After and returns the 429', async () => {
    const { site, fetcher } = await setUp({
      '/busy': { status: 429, headers: { 'retry-after': '120' } },
    });
    const response = await fetcher.fetch(`${site.origin}/busy`);
    expect(response.status).toBe(429);
  });

  it('serves a repeated GET from the scan cache', async () => {
    const { site, fetcher } = await setUp({ '/page': { body: 'once' } });
    await fetcher.fetch(`${site.origin}/page`);
    await fetcher.fetch(`${site.origin}/page`);
    expect(site.hitsFor('/page')).toHaveLength(1);
  });

  it('sends the scanner user agent', async () => {
    const { site, fetcher } = await setUp({ '/page': { body: 'x' } });
    await fetcher.fetch(`${site.origin}/page`);
    expect(site.hitsFor('/page')[0].headers['user-agent']).toContain(
      'DocumentationAI-AgentScore',
    );
  });
});

describe('the default guard', () => {
  it('never sends a request to a loopback URL', async () => {
    const guarded = new GuardedFetcher({
      userAgent: 'test',
      robotsToken: 'test',
      requestTimeoutMs: 1_000,
      maxBodyBytes: 1_000,
      maxRedirects: 1,
      minIntervalMs: 0,
      maxConcurrentPerOrigin: 1,
      maxRequests: 5,
      maxRetryAfterMs: 0,
    });
    await expect(guarded.fetch('http://127.0.0.1/')).rejects.toBeInstanceOf(
      BlockedTargetError,
    );
    await expect(guarded.fetch('http://localhost/')).rejects.toBeInstanceOf(
      BlockedTargetError,
    );
    await guarded.close();
  });
});

describe('retryAfterMs', () => {
  it('reads seconds and HTTP dates', () => {
    const now = Date.parse('2026-09-23T10:00:00Z');
    expect(retryAfterMs('5', now)).toBe(5_000);
    expect(retryAfterMs('Wed, 23 Sep 2026 10:00:30 GMT', now)).toBe(30_000);
    expect(retryAfterMs('soon', now)).toBeNull();
    expect(retryAfterMs(null, now)).toBeNull();
  });
});
