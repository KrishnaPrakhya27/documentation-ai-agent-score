import type { Grade } from './report.types';

/**
 * Every number that shapes a score, versioned together. Changing any of them
 * means a new METHODOLOGY_VERSION, because reports scored under different
 * rules must never be compared as if they were the same measurement.
 */

export const METHODOLOGY_VERSION = '2026-09.6';
/** The engine's own version, recorded in every report; the npm version once the engine is published. */
export const ENGINE_VERSION = '0.2.0';
/** Pinned exactly in package.json; packageVersions.vitest.ts keeps the two in step. */
export const AFDOCS_VERSION = '0.20.0';

/**
 * Points for our own checks, on AFDocs' scale: critical 10, high 7, medium 4,
 * low 2. Each is a maximum; a check earns a share of it in proportion to
 * what passed. AFDocs' 23 checks keep AFDocs' own points (130 in total).
 *
 * These are a weighting policy, not a measured finding: they are checked
 * against real sites before any change, and a change bumps the methodology.
 */
export const CHECK_POINTS = {
  /** Search crawlers and the AI fetchers that honour robots.txt may read the docs. */
  'crawler-permissions': 5,
  /** The sitemap lists the docs pages we found on our own. */
  'sitemap-coverage': 3,
  /** Sampled pages state when they were last changed. */
  'update-info': 2,
  /** Links, and links to sections, on the sampled pages resolve. */
  'links-and-anchors': 6,
  /** A sample of the sitemap's docs entries still exists. */
  'sitemap-live': 3,
  /** Endpoints the docs mention exist in the published OpenAPI spec. */
  'api-spec-match': 5,
  /** Where the docs use an operation the spec marks deprecated, they say so. */
  'deprecation-notices': 5,
  /** The answering agent reached the page that holds each answer. */
  'evidence-retrieved': 7,
  /** Its answers agree with the sentence they came from. */
  'answers-correct': 14,
  /** Its answers' claims are backed by the passages it cited. */
  'answers-supported': 7,
} as const;

export type OurCheckId = keyof typeof CHECK_POINTS;

/** When a score is provisional: shown, but kept off the leaderboard and out of search. */
export const PROVISIONAL_RULES = {
  minPages: 5,
  /** Share of the checks that applied but ended unverified. */
  maxUnverifiedShare: 0.25,
} as const;

/** Composite grade scale from the product brief; AFDocs keeps its own. */
export function gradeFor(score: number): Grade {
  if (score >= 97) return 'A+';
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

export const ROBOTS_TOKEN = 'DocumentationAI-AgentScore';
export const USER_AGENT = `Mozilla/5.0 (compatible; ${ROBOTS_TOKEN}/1.0; +https://documentation.ai/agent-score)`;

export const SCAN_LIMITS = {
  /** Pages AFDocs and our page checks read; 15 matches what Mintlify's checker samples. */
  samplePages: 15,
  technicalDeadlineMs: 150_000,
  requestTimeoutMs: 15_000,
  /** Real docs pages reach 5 MB (license lists); a cut-off page reads as broken Markdown. */
  maxBodyBytes: 10 * 1024 * 1024,
  maxRedirects: 5,
  minIntervalMs: 200,
  maxConcurrentPerOrigin: 3,
  technicalRequestBudget: 600,
  maxRetryAfterMs: 10_000,
  resolveDeadlineMs: 15_000,
  resolveRequestBudget: 30,
} as const;

export const ANSWERABILITY_LIMITS = {
  minQuestions: 5,
  maxQuestions: 8,
  maxPagesForQuestions: 10,
  maxCharsPerSourcePage: 5_000,
  maxFetchesPerQuestion: 5,
  /** What one fetch hands the agent, like an agent's own truncation. */
  maxCharsPerFetch: 40_000,
  /** Stops starting new questions past this many input tokens in one run. */
  maxInputTokensPerRun: 700_000,
  /** Pages rendered with a browser when their raw HTML has almost no text. */
  maxRenderedPages: 2,
  solveConcurrency: 3,
  solveTimeoutMs: 75_000,
  deadlineMs: 180_000,
  requestBudget: 120,
} as const;

/** USD per million tokens, for the spend estimate every run records. */
export const MODEL_PRICES: Record<string, { input: number; output: number }> = {
  'anthropic/claude-haiku-4.5': { input: 1, output: 5 },
  'anthropic/claude-haiku-4-5-20251001': { input: 1, output: 5 },
  'anthropic/claude-sonnet-5': { input: 2, output: 10 },
  'anthropic/claude-opus-5.5': { input: 4, output: 20 },
  'anthropic/claude-opus-5-5': { input: 4, output: 20 },
};

/** Priced conservatively when a model is missing from the table. */
export const FALLBACK_MODEL_PRICE = { input: 5, output: 25 };
