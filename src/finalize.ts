import type { AgentScoreReport, AnswerabilityResult, TopFix } from './report.types';
import { buildFixPrompt } from './reportText';
import { overallScore } from './scoring';

/**
 * Settles a technical report once Answerability has run (or cannot): fills
 * the pillar, computes the composite, and, when agents failed several
 * questions, leads the top fixes with what would have let them answer.
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
  const pillars = { ...technical.pillars, answerability };
  const report: AgentScoreReport = {
    ...technical,
    stage: 'final',
    pillars,
    overall: overallScore(pillars),
    topFixes: withAnswerabilityFix(technical.topFixes, answerability),
    timings: { ...technical.timings, completedAt: new Date(now).toISOString() },
  };
  if (answerability.state !== 'complete' && answerability.reason) {
    report.limitations = [...technical.limitations, answerability.reason];
  }
  report.fixPrompt = buildFixPrompt(report, reportUrl);
  return report;
}

function withAnswerabilityFix(fixes: TopFix[], answerability: AnswerabilityResult): TopFix[] {
  if (answerability.state !== 'complete' || answerability.score === null) return fixes;
  const failures = answerability.transcript.filter((entry) => entry.verdict !== 'correct');
  if (failures.length < 2 || answerability.score >= 80) return fixes;

  const counts = ANSWERABILITY_FIXES.map((candidate) => ({
    candidate,
    count: failures.filter((entry) => candidate.pattern.test(entry.reason)).length,
  })).sort((a, b) => b.count - a.count);
  const leading = counts[0];
  if (!leading || leading.count === 0) return fixes;

  const fix: TopFix = {
    checkId: 'answerability',
    title: `Agents could not answer ${failures.length} of ${answerability.total} questions`,
    fix: leading.candidate.fix,
  };
  return [fix, ...fixes].slice(0, 3);
}
