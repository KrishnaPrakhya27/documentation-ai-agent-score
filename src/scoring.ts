import { ourCheck, round1 } from './checks/ourCheck';
import { gradeFor, PROVISIONAL_RULES } from './methodology';
import type {
  AfdocsSummary,
  AnswerabilityResult,
  GroupId,
  GroupScore,
  OverallScore,
  ReportCheck,
  TopFix,
} from './report.types';

/**
 * One points table. Every check carries what it is worth and what the site
 * earned; the score is earned over possible, and a check that could not run
 * leaves both sums. AFDocs' caps hold the score down the way they hold
 * AFDocs' own score down. A score is provisional when the scan could not
 * stand behind it: too few pages, throttling, or too much left unverified.
 */

export const GROUP_IDS: GroupId[] = ['access', 'freshness', 'answerability'];

export const GROUP_LABELS: Record<GroupId, string> = {
  access: 'Access',
  freshness: 'Freshness',
  answerability: 'Answerability',
};

/** Freshness categories that compare the docs with a source of truth, rather than just watch maintenance. */
const CURRENCY_CATEGORIES = new Set(['consistency', 'currency']);

export interface ScoreInput {
  checks: ReportCheck[];
  afdocs: AfdocsSummary | null;
  answerability: AnswerabilityResult;
  coverage: { pagesTested: number; rateLimitedRequests: number };
}

export function scoreReport(input: ScoreInput): { overall: OverallScore; groups: Record<GroupId, GroupScore> } {
  const groups: Record<GroupId, GroupScore> = {
    access: groupScore('access', input.checks),
    freshness: groupScore('freshness', input.checks),
    answerability: answerabilityGroup(input.checks, input.answerability),
  };
  const counted = input.checks.filter((check) => check.points.earned !== null);
  const earned = round1(counted.reduce((sum, check) => sum + (check.points.earned ?? 0), 0));
  const possible = round1(counted.reduce((sum, check) => sum + check.points.max, 0));

  if (possible === 0) {
    return {
      overall: {
        score: null,
        grade: null,
        earned,
        possible,
        provisional: true,
        provisionalReasons: ['None of the checks could run, so there is nothing to score.'],
        reason: 'None of the checks could run, so there is no score.',
      },
      groups,
    };
  }

  const raw = Math.round((earned / possible) * 100);
  const cap = input.afdocs?.cap && input.afdocs.cap.value < raw ? input.afdocs.cap : undefined;
  const score = cap ? cap.value : raw;
  const provisionalReasons = provisionalReasonsFor(input.checks, input.coverage);
  return {
    overall: {
      score,
      grade: gradeFor(score),
      earned,
      possible,
      ...(cap && { cap }),
      provisional: provisionalReasons.length > 0,
      provisionalReasons,
      reason: scoreReason(groups, input.answerability, earned, possible, cap),
    },
    groups,
  };
}

function groupScore(id: GroupId, checks: ReportCheck[]): GroupScore {
  const counted = checks.filter((check) => check.group === id && check.points.earned !== null);
  const earned = round1(counted.reduce((sum, check) => sum + (check.points.earned ?? 0), 0));
  const possible = round1(counted.reduce((sum, check) => sum + check.points.max, 0));
  if (possible === 0) {
    return {
      id,
      label: GROUP_LABELS[id],
      state: 'unavailable',
      earned,
      possible,
      score: null,
      note: id === 'freshness' ? 'No freshness check could run on this site.' : 'None of the access checks could run.',
    };
  }
  const maintenanceOnly =
    id === 'freshness' && !counted.some((check) => CURRENCY_CATEGORIES.has(check.category));
  return {
    id,
    label: GROUP_LABELS[id],
    state: 'complete',
    earned,
    possible,
    score: Math.round((earned / possible) * 100),
    ...(maintenanceOnly && {
      note: 'Maintenance only: no API spec was found, so nothing here verifies that the content is current.',
    }),
  };
}

function answerabilityGroup(checks: ReportCheck[], answerability: AnswerabilityResult): GroupScore {
  if (answerability.state === 'complete') return groupScore('answerability', checks);
  return {
    id: 'answerability',
    label: GROUP_LABELS.answerability,
    state: answerability.state,
    earned: 0,
    possible: 0,
    score: null,
    note:
      answerability.state === 'pending'
        ? 'An agent is answering questions from these pages now; this part is added when it finishes.'
        : (answerability.reason ?? 'Answerability was not tested in this scan.'),
  };
}

function scoreReason(
  groups: Record<GroupId, GroupScore>,
  answerability: AnswerabilityResult,
  earned: number,
  possible: number,
  cap: OverallScore['cap'],
): string {
  const parts = [`${earned} of ${possible} possible points.`];
  if (answerability.state === 'pending') {
    parts.push('Answerability is still being tested and will be added when it finishes.');
  }
  if (groups.freshness.note) parts.push(groups.freshness.note);
  if (cap) parts.push(`Held at ${cap.value} by an AFDocs cap: ${cap.reason}`);
  return parts.join(' ');
}

/** Why a score is provisional; empty when the scan can stand behind it. */
export function provisionalReasonsFor(
  checks: ReportCheck[],
  coverage: { pagesTested: number; rateLimitedRequests: number },
): string[] {
  const reasons: string[] = [];
  if (coverage.pagesTested < PROVISIONAL_RULES.minPages) {
    reasons.push(
      `Only ${coverage.pagesTested} page${coverage.pagesTested === 1 ? '' : 's'} could be read; a score needs at least ${PROVISIONAL_RULES.minPages}.`,
    );
  }
  if (coverage.rateLimitedRequests > 0) {
    reasons.push(
      `The site refused ${coverage.rateLimitedRequests} request${coverage.rateLimitedRequests === 1 ? '' : 's'} as too many, so some checks may read low.`,
    );
  }
  const applicable = checks.filter((check) => check.status !== 'skip');
  const unverified = applicable.filter((check) => check.status === 'unverified').length;
  if (applicable.length && unverified / applicable.length > PROVISIONAL_RULES.maxUnverifiedShare) {
    reasons.push(`${unverified} of the ${applicable.length} checks that apply could not be verified.`);
  }
  return reasons;
}

/** The Answerability checks, from a completed run; none while it is pending or unavailable. */
export function answerabilityChecks(result: AnswerabilityResult): ReportCheck[] {
  if (result.state !== 'complete' || result.total === 0) return [];
  const retrieved = result.retrieved / result.total;
  const correct = result.correct / result.total;
  const checks = [
    ourCheck(
      'evidence-retrieved',
      retrieved === 1 ? 'pass' : retrieved >= 0.5 ? 'warn' : 'fail',
      retrieved,
      `The agent reached the page holding the answer for ${result.retrieved} of ${result.total} questions.`,
      retrieved === 1
        ? undefined
        : 'Make every page reachable from the docs entry page and llms.txt, with titles in the words people use, so an agent can find the page that answers a question.',
    ),
    ourCheck(
      'answers-correct',
      correct === 1 ? 'pass' : correct >= 0.5 ? 'warn' : 'fail',
      correct,
      `${result.correct} of ${result.total} answers agreed with the sentence they came from.`,
      correct === 1
        ? undefined
        : 'State each answer plainly near the top of the section that covers it, in the words people use when they ask, so an agent reading the page gives the right answer.',
    ),
  ];
  if (result.answered === 0) {
    checks.push(ourCheck('answers-supported', 'skip', null, 'The agent gave no answers to check for support.'));
  } else {
    const supported = result.supported / result.answered;
    checks.push(
      ourCheck(
        'answers-supported',
        supported === 1 ? 'pass' : supported >= 0.5 ? 'warn' : 'fail',
        supported,
        `${result.supported} of ${result.answered} answers were backed by the pages the agent cited.`,
        supported === 1
          ? undefined
          : 'Keep each fact on the page that makes the claim, so an answer can cite the passage it came from.',
      ),
    );
  }
  return checks;
}

/** The three changes that would recover the most points, largest first. */
export function pickTopFixes(checks: ReportCheck[]): TopFix[] {
  return checks
    .filter((check) => check.fix && check.points.earned !== null && (check.status === 'fail' || check.status === 'warn'))
    .map((check) => ({ check, lost: round1(check.points.max - (check.points.earned ?? 0)) }))
    .filter((entry) => entry.lost > 0)
    .sort((a, b) => b.lost - a.lost || statusRank(a.check) - statusRank(b.check))
    .slice(0, 3)
    .map(({ check, lost }) => ({
      checkId: check.id,
      title: check.title,
      fix: check.fix as string,
      points: lost,
    }));
}

function statusRank(check: ReportCheck): number {
  return check.status === 'fail' ? 0 : 1;
}

/** The limitation line that states a provisional score; absent when the score stands. */
export function provisionalLimitation(overall: OverallScore): string | null {
  return overall.provisional ? `The score is provisional: ${overall.provisionalReasons.join(' ')}` : null;
}
