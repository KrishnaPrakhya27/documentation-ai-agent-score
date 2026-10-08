import { runChecks } from 'afdocs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runAfdocs } from '../afdocs/runAfdocs';
import { GuardedFetcher } from '../transport/guardedFetch';
import { docsSiteRoutes } from './fixtureDocsSite';
import {
  allowOnly,
  startFixtureSite,
  type FixtureRoute,
  type FixtureSite,
} from './fixtureServer';

/**
 * Parity: the same site must get the same AFDocs verdicts and score whether
 * the checks run through AFDocs' own fetch or our guarded transport.
 */

const routes: Record<string, FixtureRoute> = {};
let site: FixtureSite;

beforeAll(async () => {
  site = await startFixtureSite(routes);
  Object.assign(routes, docsSiteRoutes(site.origin));
});

afterAll(async () => {
  await site.close();
});

const options = {
  samplingStrategy: 'deterministic' as const,
  maxLinksToTest: 10,
  requestDelay: 0,
  maxConcurrency: 3,
};

function fixtureFetcher(maxRequests: number): GuardedFetcher {
  return new GuardedFetcher({
    userAgent: 'test-agent',
    robotsToken: 'test-agent',
    requestTimeoutMs: 5_000,
    maxBodyBytes: 2 * 1024 * 1024,
    maxRedirects: 5,
    minIntervalMs: 0,
    maxConcurrentPerOrigin: 3,
    maxRequests,
    maxRetryAfterMs: 0,
    validateUrl: allowOnly(site.origin),
    isAllowedAddress: () => true,
  });
}

describe('runAfdocs', () => {
  it('matches native AFDocs verdicts and score on the same site', async () => {
    const native = await runChecks(`${site.origin}/docs`, options);

    const fetcher = fixtureFetcher(500);
    const ours = await runAfdocs(`${site.origin}/docs`, fetcher, options);
    await fetcher.close();

    const verdicts = (results: typeof native.results) =>
      results.map((result) => `${result.id}:${result.status}`);
    expect(verdicts(ours.report.results)).toEqual(verdicts(native.results));
    expect(ours.report.results).toHaveLength(23);
    expect(ours.sampledUrls.length).toBeGreaterThanOrEqual(5);

    const { computeScore } = await import('afdocs');
    expect(ours.score.overall).toBe(computeScore(native).overall);
  });

  it('leaves checks cut short by our own request limit out of the score instead of failing them', async () => {
    const fullFetcher = fixtureFetcher(500);
    const full = await runAfdocs(`${site.origin}/docs`, fullFetcher, options);
    await fullFetcher.close();

    const limitedFetcher = fixtureFetcher(25);
    const limited = await runAfdocs(`${site.origin}/docs`, limitedFetcher, options);
    await limitedFetcher.close();

    const fullStatus = new Map(full.report.results.map((result) => [result.id, result.status]));
    const unfairlyFailed = limited.report.results.filter(
      (result) =>
        (result.status === 'fail' || result.status === 'warn') && fullStatus.get(result.id) === 'pass',
    );
    expect(unfairlyFailed.map((result) => result.id)).toEqual([]);
    expect(limited.report.results.some((result) => result.message.startsWith('Not finished'))).toBe(true);
  });

  it('leaves checks out of the score when robots.txt kept our scanner from pages they needed', async () => {
    const guardedRoutes: Record<string, FixtureRoute> = {};
    const guardedSite = await startFixtureSite(guardedRoutes);
    Object.assign(guardedRoutes, docsSiteRoutes(guardedSite.origin), {
      '/robots.txt': { headers: { 'content-type': 'text/plain' }, body: 'User-agent: test-agent\nDisallow: /docs/install' },
    });
    const fetcher = new GuardedFetcher({
      userAgent: 'test-agent',
      robotsToken: 'test-agent',
      requestTimeoutMs: 5_000,
      maxBodyBytes: 2 * 1024 * 1024,
      maxRedirects: 5,
      minIntervalMs: 0,
      maxConcurrentPerOrigin: 3,
      maxRequests: 500,
      maxRetryAfterMs: 0,
      validateUrl: allowOnly(guardedSite.origin),
      isAllowedAddress: () => true,
    });
    const guarded = await runAfdocs(`${guardedSite.origin}/docs`, fetcher, options);
    expect(fetcher.stats().robotsBlocked.length).toBeGreaterThan(0);
    await fetcher.close();
    await guardedSite.close();

    const openFetcher = fixtureFetcher(500);
    const open = await runAfdocs(`${site.origin}/docs`, openFetcher, options);
    await openFetcher.close();

    const openStatus = new Map(open.report.results.map((result) => [result.id, result.status]));
    const unfairlyFailed = guarded.report.results.filter(
      (result) => (result.status === 'fail' || result.status === 'warn') && openStatus.get(result.id) === 'pass',
    );
    expect(unfairlyFailed.map((result) => `${result.id}: ${result.message}`)).toEqual([]);
  });
});
