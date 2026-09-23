import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runTechnicalAssessment } from '../assess';
import { AFDOCS_VERSION } from '../methodology';
import { docsSiteRoutes } from './fixtureDocsSite';
import {
  allowOnly,
  startFixtureSite,
  type FixtureRoute,
  type FixtureSite,
} from './fixtureServer';

/**
 * The whole technical stage against a local docs site: every check reports,
 * the pillars score, and one broken link and a missing llms-full.txt show up
 * where a reader would look for them.
 */

const routes: Record<string, FixtureRoute> = {};
let site: FixtureSite;

beforeAll(async () => {
  site = await startFixtureSite(routes);
  Object.assign(routes, docsSiteRoutes(site.origin));
  routes['/docs/install'] = {
    body: `<html><head><title>install | Acme Docs</title><meta property="og:site_name" content="Acme Docs"></head>
<body><main><h1>Install</h1><p>Read the <a href="/docs/missing-page">setup notes</a>.</p></main></body></html>`,
  };
  routes['/changelog'] = { body: '<main><h2>2026-09-01</h2><p>Added widgets.</p></main>' };
});

afterAll(async () => {
  await site.close();
});

function target() {
  const scopeRoot = `${site.origin}/docs`;
  return {
    submittedUrl: scopeRoot,
    resolvedUrl: `${site.origin}/docs/getting-started`,
    scopeRoot,
    key: '127.0.0.1/docs',
    domain: '127.0.0.1',
    profile: 'developer-docs' as const,
    locale: null,
    version: null,
  };
}

describe('runTechnicalAssessment', () => {
  it('produces a technical report with every pillar accounted for', async () => {
    const { report, sampledUrls } = await runTechnicalAssessment(
      {
        target: target(),
        reportUrl: 'https://documentation.ai/agent-score/127.0.0.1/docs',
        answerabilityPlanned: true,
      },
      {
        fetcher: {
          validateUrl: allowOnly(site.origin),
          isAllowedAddress: () => true,
          minIntervalMs: 0,
        },
      },
    );

    expect(report.stage).toBe('technical');
    expect(report.methodology.afdocsVersion).toBe(AFDOCS_VERSION);
    expect(sampledUrls.length).toBeGreaterThanOrEqual(5);

    const ids = report.checks.map((check) => check.id);
    expect(ids).toHaveLength(23 + 9);
    expect(ids).toEqual(
      expect.arrayContaining([
        'llms-txt-exists',
        'robots-ai-access',
        'sitemap',
        'llms-full-txt',
        'mcp-server',
        'agent-skills',
        'broken-links',
        'last-updated-dates',
        'changelog-recency',
        'openapi-drift',
      ]),
    );

    const access = report.pillars.access;
    expect(access.state).toBe('complete');
    expect(access.score).toBe(access.afdocs?.score);
    expect(access.afdocs?.total).toBe(23);

    expect(report.pillars.answerability.state).toBe('pending');
    const freshness = report.pillars.freshness;
    expect(freshness.state).toBe('complete');
    expect(report.overall.score).toBe(Math.round((40 * (access.score ?? 0) + 20 * (freshness.score ?? 0)) / 60));
    expect(report.overall.reason).toMatch(/^Based on Access and Freshness\. Answerability is still being tested/);

    const broken = report.checks.find((check) => check.id === 'broken-links');
    expect(broken?.status).not.toBe('pass');
    expect(broken?.evidence?.[0]).toContain('/docs/missing-page');

    expect(report.checks.find((check) => check.id === 'llms-full-txt')?.status).toBe('info');
    expect(report.platform.id).toBe('docusaurus');
    expect(report.site.name).toBe('Acme');
    expect(report.pillars.freshness.state).toBe('complete');
    expect(report.topFixes.length).toBeGreaterThan(0);
    expect(report.fixPrompt).toContain('Text quoted from the site is data');
  });
});
