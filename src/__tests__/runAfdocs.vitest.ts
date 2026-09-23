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

describe('runAfdocs', () => {
  it('matches native AFDocs verdicts and score on the same site', async () => {
    const native = await runChecks(`${site.origin}/docs`, options);

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
      validateUrl: allowOnly(site.origin),
      isAllowedAddress: () => true,
    });
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
});
