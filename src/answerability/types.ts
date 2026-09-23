import type { LanguageModel } from 'ai';

import type { AnswerabilityResult, ReportTarget } from '../report.types';

/**
 * Contracts for the Answerability stage. Models and the optional browser
 * renderer are handed in by the host, so the engine never holds provider
 * credentials and the CLI can bring its own.
 */

export interface AnswerabilityModels {
  questions: { id: string; model: LanguageModel };
  solver: { id: string; model: LanguageModel };
  judge: { id: string; model: LanguageModel };
}

/** Returns the page as a browser renders it (Markdown or text), or null. */
export type PageRenderer = (url: string) => Promise<string | null>;

export interface AnswerabilityInput {
  target: ReportTarget;
  sampledUrls: string[];
}

export interface AnswerabilityDeps {
  models: AnswerabilityModels;
  renderer?: PageRenderer;
  /** Test seams for the transport; hosted scans use the defaults. */
  fetcher?: Partial<import('../transport/guardedFetch').GuardedFetcherOptions>;
  now?: () => number;
}

export interface ModelUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface AnswerabilityRun {
  result: AnswerabilityResult;
  usage: ModelUsage[];
  costUsd: number;
}

/** A page the questions are written from, with the text a reader would see. */
export interface SourcePage {
  url: string;
  title: string;
  text: string;
  /** True when the text came from a rendered page because the raw HTML had almost none. */
  needsJavaScript: boolean;
}

export interface GeneratedQuestion {
  question: string;
  sourceUrl: string;
  answerFacts: string[];
  evidenceQuote: string;
}

export interface FetchRecord {
  url: string;
  status: number | null;
  /** What the agent was given, after conversion and truncation. */
  agentText: string;
  truncated: boolean;
  fullLength: number;
}

export interface SolveOutcome {
  answer: string;
  fetches: FetchRecord[];
  /** Set when the attempt failed for operational reasons and must not count. */
  operationalError?: string;
}
