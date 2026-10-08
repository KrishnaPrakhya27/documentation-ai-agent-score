import { CHECK_POINTS, type OurCheckId } from '../methodology';
import type { CheckStatus, GroupId, ReportCheck } from '../report.types';

/**
 * Builds one of our own checks with its points filled in from the table in
 * methodology.ts. `credit` is the share of the points the site earned, 0 to
 * 1; null means the check did not count (skipped or unverified).
 */

export const OUR_TITLES: Record<OurCheckId, string> = {
  'crawler-permissions': 'Crawlers and AI assistants may read the docs',
  'sitemap-coverage': 'Sitemap lists the docs pages',
  'update-info': 'Pages say when they were last changed',
  'links-and-anchors': 'Links and section anchors work',
  'sitemap-live': 'Sitemap entries still exist',
  'api-spec-match': 'Endpoints in the docs exist in the API spec',
  'deprecation-notices': 'Deprecated operations are marked as such',
  'evidence-retrieved': 'Agent reaches the page that holds the answer',
  'answers-correct': 'Agent answers real questions correctly',
  'answers-supported': 'Agent answers are backed by the pages it cites',
};

export const OUR_CATEGORIES: Record<OurCheckId, string> = {
  'crawler-permissions': 'crawler-access',
  'sitemap-coverage': 'crawler-access',
  'update-info': 'maintenance',
  'links-and-anchors': 'maintenance',
  'sitemap-live': 'maintenance',
  'api-spec-match': 'consistency',
  'deprecation-notices': 'currency',
  'evidence-retrieved': 'agent-evaluation',
  'answers-correct': 'agent-evaluation',
  'answers-supported': 'agent-evaluation',
};

export const OUR_GROUPS: Record<OurCheckId, GroupId> = {
  'crawler-permissions': 'access',
  'sitemap-coverage': 'access',
  'update-info': 'freshness',
  'links-and-anchors': 'freshness',
  'sitemap-live': 'freshness',
  'api-spec-match': 'freshness',
  'deprecation-notices': 'freshness',
  'evidence-retrieved': 'answerability',
  'answers-correct': 'answerability',
  'answers-supported': 'answerability',
};

export function ourCheck(
  id: OurCheckId,
  status: CheckStatus,
  credit: number | null,
  message: string,
  fix?: string,
  evidence?: string[],
): ReportCheck {
  const max = CHECK_POINTS[id];
  const counts = credit !== null && status !== 'skip' && status !== 'unverified';
  return {
    id,
    group: OUR_GROUPS[id],
    category: OUR_CATEGORIES[id],
    title: OUR_TITLES[id],
    status,
    source: 'agent-score',
    points: { max, earned: counts ? round1(max * clamp(credit)) : null },
    message,
    ...(fix && { fix }),
    ...(evidence?.length && { evidence }),
  };
}

/** Pass, warn or fail from a share, with the usual thresholds unless a check has its own. */
export function statusForCredit(credit: number, thresholds = { pass: 1, warn: 0.5 }): CheckStatus {
  if (credit >= thresholds.pass) return 'pass';
  if (credit >= thresholds.warn) return 'warn';
  return 'fail';
}

export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}
