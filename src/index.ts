/**
 * Agent Readiness Score engine. `scanSite` runs a whole scan; hosts that run
 * the stages as separate jobs call resolveTarget, runTechnicalAssessment,
 * runAnswerability and finalizeReport themselves.
 */

export { publicReportUrl, scanSite, type ScanSiteOptions, type ScanSiteResult } from './scanSite';
export {
  createScanFetcher,
  runTechnicalAssessment,
  type EngineOptions,
  type TechnicalAssessment,
  type TechnicalAssessmentInput,
} from './assess';
export { estimateCostUsd, runAnswerability } from './answerability/runAnswerability';
export {
  AI_PROVIDERS,
  AiConfigError,
  createAnswerabilityModels,
  isAiProvider,
  type AiConfig,
  type AiProvider,
  type ModelRole,
} from './answerability/providers';
export type {
  AnswerabilityDeps,
  AnswerabilityInput,
  AnswerabilityModels,
  AnswerabilityRun,
  PageRenderer,
} from './answerability/types';
export { finalizeReport } from './finalize';
export {
  AFDOCS_VERSION,
  ANSWERABILITY_LIMITS,
  ENGINE_VERSION,
  FRESHNESS_WEIGHTS,
  METHODOLOGY_VERSION,
  PILLAR_WEIGHTS,
  ROBOTS_TOKEN,
  SCAN_LIMITS,
  USER_AGENT,
  gradeFor,
} from './methodology';
export { overallScore } from './scoring';
export {
  UnscannableTargetError,
  resolveTarget,
  type ResolvedTarget,
  type UnscannableReason,
} from './target/resolveTarget';
export { baseDomain, fingerprintFor, guessScope, normalizeSubmittedUrl, scopeKey } from './target/scope';
export { BlockedTargetError } from './transport/publicAddress';
export type * from './report.types';
