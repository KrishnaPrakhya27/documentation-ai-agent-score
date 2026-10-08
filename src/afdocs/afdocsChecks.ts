import type { CheckResult } from 'afdocs';
import { CHECK_WEIGHTS } from 'afdocs/scoring';

import { round1 } from '../checks/ourCheck';
import type { AfdocsSummary, CheckStatus, ReportCheck } from '../report.types';
import type { AfdocsRun } from './runAfdocs';

/**
 * Presents AFDocs results as report checks: short titles, the category as
 * given, AFDocs' own points for each, and AFDocs' fix text with its CLI-only
 * advice removed. Nothing here rescores; the points come straight from
 * AFDocs' `computeScore`.
 */

export const AFDOCS_TITLES: Record<string, string> = {
  'llms-txt-exists': 'llms.txt exists',
  'llms-txt-valid': 'llms.txt follows the standard structure',
  'llms-txt-size': "llms.txt fits in an agent's context",
  'llms-txt-links-resolve': 'llms.txt links work',
  'llms-txt-links-markdown': 'llms.txt links point to Markdown',
  'llms-txt-directive-html': 'Pages point agents to llms.txt',
  'llms-txt-directive-md': 'Markdown pages point agents to llms.txt',
  'markdown-url-support': 'Pages are available as Markdown',
  'content-negotiation': 'Server returns Markdown when asked',
  'rendering-strategy': 'Content is in the HTML without JavaScript',
  'page-size-markdown': 'Markdown pages fit in context',
  'page-size-html': 'HTML pages fit in context',
  'content-start-position': 'Content starts near the top',
  'tabbed-content-serialization': "Tabs don't bloat the page",
  'section-header-quality': 'Headings inside tabs name their variant',
  'markdown-code-fence-validity': 'Code blocks are well-formed',
  'http-status-codes': 'Missing pages return a real 404',
  'redirect-behavior': 'Redirects stay on the same host',
  'llms-txt-coverage': 'llms.txt covers the whole site',
  'markdown-content-parity': 'Markdown matches the HTML page',
  'cache-header-hygiene': 'Cache headers allow timely updates',
  'auth-gate-detection': 'Docs are readable without logging in',
  'auth-alternative-access': 'Gated docs offer another way in',
};

export function afdocsChecks(run: AfdocsRun): ReportCheck[] {
  return run.report.results.map((result) => {
    const score = run.score.checkScores[result.id];
    // AFDocs marks page-level checks not applicable when it read too few pages.
    const thinSample = score?.scoreDisplayMode === 'notApplicable';
    const status = statusOf(result.status, thinSample);
    const counted = score !== undefined && !thinSample && status !== 'skip' && status !== 'unverified';
    const fix = cleanResolution(run.score.resolutions[result.id]);
    const evidence = problemPages(result);
    return {
      id: result.id,
      group: 'access',
      category: result.category,
      title: AFDOCS_TITLES[result.id] ?? result.id,
      status,
      source: 'afdocs',
      points: {
        max: round1(score?.maxScore ?? CHECK_WEIGHTS[result.id]?.weight ?? 0),
        earned: counted ? round1(score.earnedScore) : null,
      },
      message: thinSample ? `Too few pages were read to score this. ${result.message}` : result.message,
      ...(fix && result.status !== 'pass' && { fix }),
      ...(evidence.length && { evidence }),
    };
  });
}

/** AFDocs' own result, kept whole so the page can label it as AFDocs. */
export function summarizeAfdocs(run: AfdocsRun): AfdocsSummary | null {
  const numeric = Object.values(run.score.checkScores).filter(
    (score) => score.scoreDisplayMode === 'numeric',
  );
  if (numeric.length === 0) return null;
  const cap = afdocsCap(run);
  return {
    score: run.score.overall,
    grade: run.score.grade,
    passed: run.report.summary.pass,
    total: run.report.summary.total,
    earned: round1(numeric.reduce((sum, score) => sum + score.earnedScore, 0)),
    possible: round1(numeric.reduce((sum, score) => sum + score.maxScore, 0)),
    ...(cap && { cap }),
  };
}

/**
 * The cap AFDocs' rules put on this site, computed from its results rather
 * than read from `score.cap`: AFDocs only reports a cap when its own score
 * exceeds it, and the combined score can rise above a cap that AFDocs' score
 * sat under (no llms.txt holds AFDocs at 59, but our Freshness points could
 * lift the total past it). Rules as in AFDocs 0.20.0 `computeCap`; lowest wins.
 */
export function afdocsCap(run: AfdocsRun): AfdocsSummary['cap'] | undefined {
  const caps: NonNullable<AfdocsSummary['cap']>[] = [];
  const llmsExists = run.report.results.find((result) => result.id === 'llms-txt-exists');
  if (llmsExists?.status === 'fail') {
    caps.push({ value: 59, checkId: 'llms-txt-exists', reason: 'No llms.txt found. Agents lose primary navigation.' });
  }
  for (const checkId of ['rendering-strategy', 'auth-gate-detection']) {
    const score = run.score.checkScores[checkId];
    if (!score || score.scoreDisplayMode === 'notApplicable') continue;
    if (score.proportion <= 0.25) {
      caps.push({ value: 39, checkId, reason: `${checkId}: 75%+ of pages affected` });
    } else if (score.proportion <= 0.5) {
      caps.push({ value: 59, checkId, reason: `${checkId}: 50%+ of pages affected` });
    }
  }
  const diagnostics = new Set(run.score.diagnostics.map((diagnostic) => diagnostic.id));
  if (diagnostics.has('no-viable-path')) {
    caps.push({
      value: 39,
      checkId: 'no-viable-path',
      reason: 'Agents have no effective way to access documentation content.',
    });
  }
  if (diagnostics.has('single-page-sample')) {
    caps.push({
      value: 59,
      checkId: 'single-page-sample',
      reason: 'Too few pages discovered to produce a representative score.',
    });
  }
  caps.sort((a, b) => a.value - b.value);
  return caps[0];
}

function statusOf(status: CheckResult['status'], thinSample: boolean): CheckStatus {
  if (thinSample || status === 'error') return 'unverified';
  if (status === 'pass' || status === 'warn' || status === 'fail' || status === 'skip') return status;
  return 'unverified';
}

/** Drops sentences that only make sense for someone running the AFDocs CLI. */
export function cleanResolution(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const kept = text
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !/--[a-z]|afdocs|config file/i.test(sentence));
  return kept.join(' ').trim() || undefined;
}

function problemPages(result: CheckResult): string[] {
  const pages = (result.details as { pageResults?: Array<{ url?: string; status?: string }> })
    ?.pageResults;
  if (!Array.isArray(pages) || result.status === 'pass') return [];
  return pages
    .filter((page) => page.url && page.status && page.status !== 'pass')
    .slice(0, 3)
    .map((page) => page.url as string);
}
