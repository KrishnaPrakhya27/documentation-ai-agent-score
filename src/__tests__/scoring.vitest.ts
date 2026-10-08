import { describe, expect, it } from 'vitest';

import { ourCheck } from '../checks/ourCheck';
import { emptyAnswerability } from '../answerability/runAnswerability';
import type { AnswerabilityResult, ReportCheck } from '../report.types';
import { answerabilityChecks, pickTopFixes, provisionalReasonsFor, scoreReport } from '../scoring';

/**
 * One points table: the score is earned over possible, a check that could
 * not run leaves both sums, AFDocs' caps hold the score down, and a scan
 * that cannot stand behind its number says so.
 */

function afdocsCheck(id: string, max: number, earned: number | null, status: ReportCheck['status'] = 'pass'): ReportCheck {
  return {
    id,
    group: 'access',
    category: 'content-discoverability',
    title: id,
    status,
    source: 'afdocs',
    points: { max, earned },
    message: '',
    ...(status !== 'pass' && { fix: `Fix ${id}` }),
  };
}

const coverage = { pagesTested: 10, rateLimitedRequests: 0 };
const notTested = emptyAnswerability('unavailable', 'Answerability was not tested in this scan.');

describe('scoreReport', () => {
  it('scores earned points over the points that could be earned', () => {
    const checks = [
      afdocsCheck('a', 10, 10),
      afdocsCheck('b', 7, 3.5, 'warn'),
      ourCheck('links-and-anchors', 'pass', 1, ''),
      ourCheck('update-info', 'fail', 0, ''),
    ];
    const { overall, groups } = scoreReport({ checks, afdocs: null, answerability: notTested, coverage });

    expect(overall).toMatchObject({ score: 78, grade: 'C', earned: 19.5, possible: 25, provisional: false });
    expect(groups.access).toMatchObject({ state: 'complete', earned: 13.5, possible: 17, score: 79 });
    expect(groups.freshness).toMatchObject({ state: 'complete', earned: 6, possible: 8, score: 75 });
    expect(groups.freshness.note).toMatch(/^Maintenance only/);
    expect(groups.answerability).toMatchObject({ state: 'unavailable', score: null });
    expect(overall.reason).not.toContain('Answerability');
  });

  it('leaves skipped and unverified checks out of both sums instead of counting them as zero', () => {
    const checks = [
      afdocsCheck('a', 10, 10),
      afdocsCheck('b', 7, null, 'skip'),
      ourCheck('sitemap-live', 'unverified', null, ''),
    ];
    const { overall } = scoreReport({ checks, afdocs: null, answerability: notTested, coverage });
    expect(overall).toMatchObject({ score: 100, earned: 10, possible: 10 });
  });

  it("holds the score at AFDocs' cap and says so", () => {
    const checks = [afdocsCheck('llms-txt-exists', 10, 0, 'fail'), afdocsCheck('b', 7, 7), ourCheck('links-and-anchors', 'pass', 1, '')];
    const cap = { value: 59, checkId: 'llms-txt-exists', reason: 'No llms.txt found.' };
    const { overall } = scoreReport({
      checks,
      afdocs: { score: 41, grade: 'F', passed: 1, total: 2, earned: 7, possible: 17, cap },
      answerability: notTested,
      coverage,
    });
    expect(overall.score).toBe(57);
    expect(overall.cap).toBeUndefined();

    const higher = scoreReport({
      checks: [...checks, ourCheck('api-spec-match', 'pass', 1, ''), ourCheck('deprecation-notices', 'pass', 1, '')],
      afdocs: { score: 41, grade: 'F', passed: 1, total: 2, earned: 7, possible: 17, cap },
      answerability: notTested,
      coverage,
    });
    expect(higher.overall.score).toBe(59);
    expect(higher.overall.cap).toEqual(cap);
    expect(higher.overall.reason).toContain('Held at 59 by an AFDocs cap');
  });

  it('has no score when nothing could be measured', () => {
    const { overall } = scoreReport({ checks: [afdocsCheck('a', 10, null, 'skip')], afdocs: null, answerability: notTested, coverage });
    expect(overall).toMatchObject({ score: null, grade: null, provisional: true });
  });

  it('keeps the freshness note off when a spec check counted', () => {
    const checks = [ourCheck('links-and-anchors', 'pass', 1, ''), ourCheck('api-spec-match', 'warn', 0.8, '')];
    const { groups } = scoreReport({ checks, afdocs: null, answerability: notTested, coverage });
    expect(groups.freshness.note).toBeUndefined();
    expect(groups.freshness).toMatchObject({ earned: 10, possible: 11, score: 91 });
  });
});

describe('provisionalReasonsFor', () => {
  it('flags thin samples, throttling and too much left unverified', () => {
    const checks = [afdocsCheck('a', 10, 10), ourCheck('sitemap-live', 'unverified', null, ''), afdocsCheck('c', 4, null, 'skip')];
    expect(provisionalReasonsFor(checks, { pagesTested: 3, rateLimitedRequests: 2 })).toEqual([
      'Only 3 pages could be read; a score needs at least 5.',
      'The site refused 2 requests as too many, so some checks may read low.',
      '1 of the 2 checks that apply could not be verified.',
    ]);
    expect(provisionalReasonsFor([afdocsCheck('a', 10, 10)], coverage)).toEqual([]);
  });
});

describe('answerabilityChecks', () => {
  const complete: AnswerabilityResult = {
    state: 'complete',
    total: 8,
    correct: 6,
    retrieved: 8,
    answered: 7,
    supported: 5,
    transcript: [],
  };

  it('turns a completed run into three checks with proportional points', () => {
    const checks = answerabilityChecks(complete);
    expect(checks.map((check) => [check.id, check.status, check.points])).toEqual([
      ['evidence-retrieved', 'pass', { max: 7, earned: 7 }],
      ['answers-correct', 'warn', { max: 14, earned: 10.5 }],
      ['answers-supported', 'warn', { max: 7, earned: 5 }],
    ]);
  });

  it('skips the support check when nothing was answered, and adds nothing until the run completes', () => {
    const checks = answerabilityChecks({ ...complete, answered: 0, supported: 0 });
    expect(checks.find((check) => check.id === 'answers-supported')).toMatchObject({ status: 'skip', points: { earned: null } });
    expect(answerabilityChecks(emptyAnswerability('pending'))).toEqual([]);
  });
});

describe('pickTopFixes', () => {
  it('orders fixes by the points they would recover', () => {
    const checks = [
      afdocsCheck('small', 4, 0, 'fail'),
      afdocsCheck('big', 10, 5, 'warn'),
      afdocsCheck('passing', 7, 7),
      ourCheck('links-and-anchors', 'fail', 0.2, '', 'Fix links'),
    ];
    expect(pickTopFixes(checks).map((fix) => [fix.checkId, fix.points])).toEqual([
      ['big', 5],
      ['links-and-anchors', 4.8],
      ['small', 4],
    ]);
  });
});
