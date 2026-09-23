import type { AfdocsRun } from './afdocs/runAfdocs';
import type { ScoredCheck } from './checks/freshness';
import { FRESHNESS_WEIGHTS, gradeFor, PILLAR_WEIGHTS } from './methodology';
import type {
  AccessResult,
  AnswerabilityResult,
  ContentProfile,
  FreshnessComponent,
  FreshnessResult,
  Grade,
  PillarState,
  ReportCheck,
  TopFix,
} from './report.types';

/**
 * Turns check results into pillar scores and the composite. Developer docs
 * use the unmodified AFDocs score; help centres use an experimental profile
 * over the same checks. When Answerability or Freshness is not measured, the
 * composite is the weighted average of the pillars that were, and says so;
 * without Access there is no composite.
 */

const HELP_CENTER_GROUPS: Array<{ weight: number; checks: string[] }> = [
  { weight: 25, checks: ['sitemap', 'robots-ai-access', 'llms-txt-exists'] },
  {
    weight: 40,
    checks: [
      'rendering-strategy',
      'page-size-html',
      'content-start-position',
      'tabbed-content-serialization',
    ],
  },
  { weight: 20, checks: ['http-status-codes', 'redirect-behavior', 'cache-header-hygiene'] },
  { weight: 15, checks: ['auth-gate-detection', 'auth-alternative-access'] },
];

export const HELP_CENTER_SCORED_CHECKS = new Set(
  HELP_CENTER_GROUPS.flatMap((group) => group.checks),
);

export function scoreAccess(
  run: AfdocsRun,
  profile: ContentProfile,
  checks: ReportCheck[],
): AccessResult {
  const summary = run.report.summary;
  const afdocs = {
    score: run.score.overall,
    grade: run.score.grade as Grade,
    passed: summary.pass,
    total: summary.total,
    ...(run.score.cap && {
      cap: {
        value: run.score.cap.cap,
        checkId: run.score.cap.checkId,
        reason: run.score.cap.reason,
      },
    }),
  };

  const measured = summary.total - summary.skip - summary.error;
  if (measured === 0) {
    return {
      state: 'unavailable',
      score: null,
      profile,
      afdocs: null,
      note: 'None of the access checks could run.',
    };
  }

  if (profile === 'developer-docs') {
    return { state: 'complete', score: run.score.overall, profile, afdocs };
  }
  return {
    state: 'complete',
    score: helpCenterAccessScore(run, checks),
    profile,
    afdocs,
    note: 'Help-centre profile (experimental): Markdown, llms.txt directives and MCP are reported but do not lower the score.',
  };
}

function helpCenterAccessScore(run: AfdocsRun, checks: ReportCheck[]): number {
  const byId = new Map(checks.map((check) => [check.id, check]));
  let earned = 0;
  let possible = 0;
  for (const group of HELP_CENTER_GROUPS) {
    const proportions = group.checks
      .map((id) => checkProportion(id, run, byId.get(id)))
      .filter((value): value is number => value !== null);
    if (proportions.length === 0) continue;
    earned += group.weight * (proportions.reduce((a, b) => a + b, 0) / proportions.length);
    possible += group.weight;
  }
  const raw = possible ? (earned / possible) * 100 : 0;
  return Math.round(Math.min(raw, helpCenterCap(run)));
}

/** AFDocs' own caps for pages that need JavaScript or a login; not its llms.txt cap. */
function helpCenterCap(run: AfdocsRun): number {
  let cap = 100;
  for (const id of ['rendering-strategy', 'auth-gate-detection']) {
    const score = run.score.checkScores[id];
    if (!score || score.scoreDisplayMode === 'notApplicable') continue;
    if (score.proportion <= 0.25) cap = Math.min(cap, 39);
    else if (score.proportion <= 0.5) cap = Math.min(cap, 59);
  }
  return cap;
}

function checkProportion(
  id: string,
  run: AfdocsRun,
  check: ReportCheck | undefined,
): number | null {
  const afdocsScore = run.score.checkScores[id];
  if (afdocsScore && afdocsScore.scoreDisplayMode === 'numeric') {
    return afdocsScore.proportion;
  }
  if (!check) return null;
  if (check.status === 'pass') return 1;
  if (check.status === 'warn') return 0.5;
  if (check.status === 'fail' || check.status === 'info') return 0;
  return null;
}

export function scoreFreshness(
  links: ScoredCheck,
  recency: ScoredCheck[],
  paritySource: ReportCheck | undefined,
): FreshnessResult {
  const recencyScores = recency
    .map((entry) => entry.score)
    .filter((score): score is number => score !== null);
  const components: FreshnessComponent[] = [
    {
      id: 'link-health',
      label: 'Working links',
      weight: FRESHNESS_WEIGHTS['link-health'],
      score: links.score,
      checkIds: [links.check.id],
    },
    {
      id: 'markdown-parity',
      label: 'Markdown matches HTML',
      weight: FRESHNESS_WEIGHTS['markdown-parity'],
      score: parityScore(paritySource),
      checkIds: ['markdown-content-parity'],
    },
    {
      id: 'recency',
      label: 'Dates, changelog and API spec',
      weight: FRESHNESS_WEIGHTS.recency,
      score: recencyScores.length
        ? Math.round(recencyScores.reduce((a, b) => a + b, 0) / recencyScores.length)
        : null,
      checkIds: recency.map((entry) => entry.check.id),
    },
  ];

  const measured = components.filter((component) => component.score !== null);
  if (measured.length === 0) {
    return {
      state: 'unavailable',
      score: null,
      components,
      reason: 'No freshness signal could be measured on the sampled pages.',
    };
  }
  const weight = measured.reduce((sum, component) => sum + component.weight, 0);
  const score = Math.round(
    measured.reduce((sum, component) => sum + component.weight * (component.score ?? 0), 0) /
      weight,
  );
  return { state: 'complete', score, components };
}

function parityScore(check: ReportCheck | undefined): number | null {
  if (!check) return null;
  if (check.status === 'pass') return 100;
  if (check.status === 'warn') return 60;
  if (check.status === 'fail') return 20;
  return null;
}

const PILLAR_NAMES = ['access', 'answerability', 'freshness'] as const;
type PillarName = (typeof PILLAR_NAMES)[number];

const PILLAR_LABELS: Record<PillarName, string> = {
  access: 'Access',
  answerability: 'Answerability',
  freshness: 'Freshness',
};

/** Whole-number weights keep the reweighted average exact, so a .5 always rounds up. */
function weightPercent(pillar: PillarName): number {
  return Math.round(PILLAR_WEIGHTS[pillar] * 100);
}

export function overallScore(pillars: {
  access: AccessResult;
  answerability: AnswerabilityResult;
  freshness: FreshnessResult;
}): { score: number | null; grade: Grade | null; reason?: string } {
  const scoreOf = (pillar: PillarName) =>
    pillars[pillar].state === 'complete' ? pillars[pillar].score : null;
  if (scoreOf('access') === null) {
    return {
      score: null,
      grade: null,
      reason: 'Access could not be measured, so there is no overall grade. The other scores are shown.',
    };
  }

  const measured = PILLAR_NAMES.filter((pillar) => scoreOf(pillar) !== null);
  const weightedSum = measured.reduce((sum, pillar) => sum + weightPercent(pillar) * (scoreOf(pillar) ?? 0), 0);
  const totalWeight = measured.reduce((sum, pillar) => sum + weightPercent(pillar), 0);
  const score = Math.round(weightedSum / totalWeight);
  if (measured.length === PILLAR_NAMES.length) return { score, grade: gradeFor(score) };
  return { score, grade: gradeFor(score), reason: partialScoreReason(measured, pillars) };
}

function partialScoreReason(
  measured: PillarName[],
  pillars: Record<PillarName, { state: PillarState }>,
): string {
  const missing = PILLAR_NAMES.filter((pillar) => !measured.includes(pillar)).map((pillar) =>
    pillars[pillar].state === 'pending'
      ? `${PILLAR_LABELS[pillar]} is still being tested and will update this score.`
      : `${PILLAR_LABELS[pillar]} was not measured for this scan.`,
  );
  return [`Based on ${measured.map((pillar) => PILLAR_LABELS[pillar]).join(' and ')}.`, ...missing].join(' ');
}

/** The three changes likely to raise the score most, largest first. */
export function pickTopFixes(
  checks: ReportCheck[],
  run: AfdocsRun,
  freshness: FreshnessResult,
  profile: ContentProfile,
): TopFix[] {
  const afdocsMax = Object.values(run.score.checkScores)
    .filter((score) => score.scoreDisplayMode === 'numeric')
    .reduce((sum, score) => sum + score.maxScore, 0);
  const freshnessWeight = freshness.components
    .filter((component) => component.score !== null)
    .reduce((sum, component) => sum + component.weight, 0);

  const impact = (check: ReportCheck): number => {
    if (!check.scored || !check.fix) return 0;
    if (check.source === 'afdocs' && profile === 'developer-docs') {
      const score = run.score.checkScores[check.id];
      if (!score || !afdocsMax) return 0;
      return (PILLAR_WEIGHTS.access * 100 * score.maxScore * (1 - score.proportion)) / afdocsMax;
    }
    if (check.pillar === 'freshness') {
      const component = freshness.components.find((entry) => entry.checkIds.includes(check.id));
      if (!component || component.score === null || !freshnessWeight) return 0;
      const share = component.weight / freshnessWeight / Math.max(1, component.checkIds.length);
      return PILLAR_WEIGHTS.freshness * share * (100 - component.score);
    }
    return check.status === 'fail' ? 1 : 0.5;
  };

  const candidates = checks
    .filter((check) => check.fix && ['fail', 'warn', 'info'].includes(check.status))
    .map((check) => ({ check, impact: impact(check) }))
    .sort((a, b) => b.impact - a.impact || statusRank(a.check) - statusRank(b.check));

  return candidates.slice(0, 3).map(({ check }) => ({
    checkId: check.id,
    title: check.title,
    fix: check.fix as string,
  }));
}

function statusRank(check: ReportCheck): number {
  return check.status === 'fail' ? 0 : check.status === 'warn' ? 1 : 2;
}
