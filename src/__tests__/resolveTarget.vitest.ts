import { afterEach, describe, expect, it } from 'vitest';

import { findDocsElsewhere } from '../target/resolveTarget';
import { GuardedFetcher } from '../transport/guardedFetch';
import { allowOnly, startFixtureSite, type FixtureRoute, type FixtureSite } from './fixtureServer';

/**
 * The docs hint for a bare-domain submission: /docs answering as a page
 * yields a hint, a home page that merely redirects does not, and a
 * submission that already names a path or a docs host gets none.
 */

let site: FixtureSite | undefined;
let fetcher: GuardedFetcher | undefined;

afterEach(async () => {
  await fetcher?.close();
  await site?.close();
  fetcher = undefined;
  site = undefined;
});

const html = { headers: { 'content-type': 'text/html' } };

async function setUp(routes: Record<string, FixtureRoute>) {
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
  });
  return { site, fetcher };
}

describe('findDocsElsewhere', () => {
  it('points at /docs when a bare domain was submitted and /docs is a page', async () => {
    const { site, fetcher } = await setUp({
      '/': { ...html, body: '<html><body>Marketing</body></html>' },
      '/docs': { ...html, body: '<html><body>Docs</body></html>' },
    });
    const root = new URL(site.origin);
    const hint = await findDocsElsewhere(root, root, fetcher);
    expect(hint).toBe(`${root.host}/docs`);
  });

  it('gives no hint when /docs is missing or only leads back to the home page', async () => {
    const { site, fetcher } = await setUp({
      '/': { ...html, body: '<html><body>Marketing</body></html>' },
      '/docs': { status: 302, headers: { location: '/' }, body: '' },
    });
    const root = new URL(site.origin);
    expect(await findDocsElsewhere(root, root, fetcher)).toBeUndefined();
  });

  it('is skipped when the submission already names a path or a docs host', async () => {
    const { site, fetcher } = await setUp({
      '/docs': { ...html, body: '<html><body>Docs</body></html>' },
    });
    const withPath = new URL(`${site.origin}/guides`);
    expect(await findDocsElsewhere(withPath, withPath, fetcher)).toBeUndefined();
    const docsHost = new URL('https://docs.example.com/');
    expect(await findDocsElsewhere(docsHost, docsHost, fetcher)).toBeUndefined();
  });
});
