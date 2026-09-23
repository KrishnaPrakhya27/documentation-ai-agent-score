import type { Grade } from './report.types';

/**
 * Every number that shapes a score, versioned together. Changing any of them
 * means a new METHODOLOGY_VERSION, because reports scored under different
 * rules must never be compared as if they were the same measurement.
 */

export const METHODOLOGY_VERSION = '2026-09.2';
/** This package's version; packageVersions.vitest.ts keeps it equal to package.json. */
export const ENGINE_VERSION = '0.1.0';
/** Pinned exactly in package.json; packageVersions.vitest.ts keeps the two in step. */
export const AFDOCS_VERSION = '0.20.0';

export const PILLAR_WEIGHTS = {
  access: 0.4,
  answerability: 0.4,
  freshness: 0.2,
} as const;

export const FRESHNESS_WEIGHTS = {
  'link-health': 50,
  'markdown-parity': 30,
  recency: 20,
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
  samplePages: 10,
  technicalDeadlineMs: 45_000,
  requestTimeoutMs: 10_000,
  maxBodyBytes: 2 * 1024 * 1024,
  maxRedirects: 5,
  minIntervalMs: 200,
  maxConcurrentPerOrigin: 3,
  technicalRequestBudget: 260,
  maxRetryAfterMs: 10_000,
  resolveDeadlineMs: 8_000,
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
