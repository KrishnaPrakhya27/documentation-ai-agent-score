import { round1 } from './checks/ourCheck';
import type { AgentScoreReport, AnswerabilityResult, TopFix } from './report.types';
import { buildFixPrompt } from './reportText';
import { answerabilityChecks, pickTopFixes, provisionalLimitation, scoreReport } from './scoring';

/**
 * Settles a technical report once Answerability has run (or cannot): adds
 * its checks to the table, rescores, and, when agents failed several
 * questions for one reason, leads the top fixes with what would have let
 * them answer.
 */

const ANSWERABILITY_FIXES: Array<{ pattern: RegExp; fix: string }> = [
  {
    pattern: /never reached/,
    fix: 'Make every page easy to find: list it in llms.txt and the sitemap, link related pages to each other, and use titles and headings in the words people search with.',
  },
  {
    pattern: /cut off/,
    fix: 'Keep answers within the first part of a page: split very long pages and move navigation and boilerplate out of the HTML so agents reach the content before their limit.',
  },
  {
    pattern: /JavaScript|not in the text it received/,
    fix: 'Server-render all page content, including tabs, accordions and code examples, so the answer is in the HTML an agent receives.',
  },
  {
    pattern: /did not recognise|answered incorrectly/,
    fix: 'State answers directly near the top of the section that covers them, using the same words people use when they ask.',
  },
];

export function finalizeReport(
  technical: AgentScoreReport,
  answerability: AnswerabilityResult,
  reportUrl: string,
  now = Date.now(),
): AgentScoreReport {
  const checks = [
    ...technical.checks.filter((check) => check.group !== 'answerability'),
    ...answerabilityChecks(answerability),
  ];
  const { overall, groups } = scoreReport({
    checks,
    afdocs: technical.afdocs,
    answerability,
    coverage: technical.coverage,
  });
  const report: AgentScoreReport = {
    ...technical,
    stage: 'final',
    answerability,
    checks,
    overall,
    groups,
    topFixes: withAnswerabilityFix(pickTopFixes(checks), checks, answerability),
    timings: { ...technical.timings, completedAt: new Date(now).toISOString() },
  };
  report.limitations = finalLimitations(technical.limitations, overall, answerability);
  report.fixPrompt = buildFixPrompt(report, reportUrl);
  return report;
}

/** The technical stage's notes with the provisional line restated for the final score, plus why Answerability is missing. */
export function finalLimitations(
  technical: string[],
  overall: AgentScoreReport['overall'],
  answerability: AnswerabilityResult,
): string[] {
  const notes = technical.filter((note) => !note.startsWith('The score is provisional:'));
  const provisional = provisionalLimitation(overall);
  if (provisional) notes.push(provisional);
  if (answerability.state !== 'complete' && answerability.reason) notes.push(answerability.reason);
  return notes;
}

/** One fix for the cause behind most misses, in place of the generic Answerability fixes. */
function withAnswerabilityFix(
  fixes: TopFix[],
  checks: AgentScoreReport['checks'],
  answerability: AnswerabilityResult,
): TopFix[] {
  if (answerability.state !== 'complete' || answerability.total === 0) return fixes;
  const failures = answerability.transcript.filter((entry) => entry.verdict !== 'correct');
  if (failures.length < 2 || answerability.correct / answerability.total >= 0.8) return fixes;

  const counts = ANSWERABILITY_FIXES.map((candidate) => ({
    candidate,
    count: failures.filter((entry) => candidate.pattern.test(entry.reason)).length,
  })).sort((a, b) => b.count - a.count);
  const leading = counts[0];
  if (!leading || leading.count === 0) return fixes;

  const lost = checks
    .filter((check) => check.group === 'answerability' && check.points.earned !== null)
    .reduce((sum, check) => sum + check.points.max - (check.points.earned ?? 0), 0);
  const fix: TopFix = {
    checkId: 'answerability',
    title: `Agents could not answer ${failures.length} of ${answerability.total} questions`,
    fix: leading.candidate.fix,
    points: round1(lost),
  };
  const others = fixes.filter((entry) => !checks.some((check) => check.group === 'answerability' && check.id === entry.checkId));
  return [fix, ...others].sort((a, b) => b.points - a.points).slice(0, 3);
}
