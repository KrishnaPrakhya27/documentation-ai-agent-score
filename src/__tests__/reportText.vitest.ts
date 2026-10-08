import { describe, expect, it } from 'vitest';

import { emptyAnswerability } from '../answerability/runAnswerability';
import type { AdditionalCheck, AgentScoreReport, ReportCheck } from '../report.types';
import { buildFixPrompt } from '../reportText';

/**
 * The fix prompt is pasted straight into a coding agent, so it must list
 * every problem the report shows, most important first, each with its
 * points and a way to confirm the fix before rescanning.
 */

const check = (id: string, status: ReportCheck['status'], max = 7, earned: number | null = 0): ReportCheck => ({
  id,
  group: 'access',
  category: 'content-discoverability',
  title: `Title ${id}`,
  status,
  source: 'afdocs',
  points: { max, earned },
  message: `Found ${id}`,
  fix: `Fix ${id}`,
});

const extra = (id: string, status: AdditionalCheck['status']): AdditionalCheck => ({
  id,
  title: `Title ${id}`,
  status,
  message: `Found ${id}`,
  fix: `Fix ${id}`,
});

function reportWith(
  checks: ReportCheck[],
  topFixIds: string[] = [],
  additionalChecks: AdditionalCheck[] = [],
): AgentScoreReport {
  return {
    target: { scopeRoot: 'https://docs.example.com', key: 'docs.example.com' },
    site: { name: 'Example', title: null },
    overall: { score: 80, grade: 'B', earned: 128, possible: 160, provisional: false, provisionalReasons: [] },
    answerability: emptyAnswerability('unavailable', 'Answerability was not tested in this scan.'),
    checks,
    additionalChecks,
    topFixes: topFixIds.map((checkId) => ({ checkId, title: '', fix: '', points: 1 })),
    coverage: { pagesTested: 10, sampledUrls: ['https://docs.example.com/start'] },
    timings: { startedAt: '2026-09-23T10:00:00.000Z' },
  } as unknown as AgentScoreReport;
}

const REPORT_URL = 'https://documentation.ai/agent-score/example';

describe('buildFixPrompt', () => {
  it('states the site, the score in points and what it rests on', () => {
    const prompt = buildFixPrompt(reportWith([check('llms-txt-exists', 'fail')]), REPORT_URL);
    expect(prompt).toContain('# Agent Readiness Score fix report: Example');
    expect(prompt).toContain('- Score: 80/100 (B), 128 of 160 points.');
    expect(prompt).toContain(`- Full report: ${REPORT_URL}`);
  });

  it('groups problems by status, top fixes first, then by the points at stake, and lists optional interfaces last', () => {
    const prompt = buildFixPrompt(
      reportWith(
        [
          check('page-size-html', 'warn', 7, 3.5),
          check('llms-txt-exists', 'fail', 10, 0),
          check('cache-header-hygiene', 'fail', 2, 0),
          check('passing', 'pass', 4, 4),
        ],
        ['cache-header-hygiene'],
        [extra('mcp-server', 'missing'), extra('llms-full-txt', 'found')],
      ),
      REPORT_URL,
    );
    expect(prompt).toContain('The scan found 2 failing checks, 1 partly passing check and 1 optional interface it could add.');
    const order = [
      '### 1. Title cache-header-hygiene',
      '### 2. Title llms-txt-exists',
      '- Check: `llms-txt-exists` in Content discoverability (Access), worth 10 points, earned 0',
      '## Partly passing checks (1)',
      '### 3. Title page-size-html',
      '## Optional interfaces, not scored (1)',
      '### 4. Title mcp-server',
    ];
    const positions = order.map((text) => prompt.indexOf(text));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(prompt).not.toContain('Title llms-full-txt');
  });

  it('gives a concrete way to check a fix, using a page the scan read', () => {
    const prompt = buildFixPrompt(reportWith([check('content-negotiation', 'fail')]), REPORT_URL);
    expect(prompt).toContain(
      '- Check your fix: `curl -sI -H "Accept: text/markdown" https://docs.example.com/start` returns `content-type: text/markdown`.',
    );
  });

  it('says so plainly when there is nothing to fix', () => {
    expect(buildFixPrompt(reportWith([check('llms-txt-exists', 'pass', 10, 10)]), REPORT_URL)).toBe(
      `The Agent Readiness Score scan of https://docs.example.com found nothing to fix. Full report: ${REPORT_URL}`,
    );
  });
});
