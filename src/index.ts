/**
 * Agent Readiness Score engine. `scanSite` runs a whole scan; hosts that run
 * the stages as separate jobs call resolveTarget, runTechnicalAssessment,
 * runAnswerability and finalizeReport themselves.
 */

export { reportUrlForKey, scanSite, type ScanSiteOptions, type ScanSiteResult } from './scanSite';
export {
  createScanFetcher,
  runTechnicalAssessment,
  type EngineOptions,
  type TechnicalAssessment,
  type TechnicalAssessmentInput,
} from './assess';
export { emptyAnswerability, estimateCostUsd, runAnswerability } from './answerability/runAnswerability';
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
  CHECK_POINTS,
  ENGINE_VERSION,
  METHODOLOGY_VERSION,
  PROVISIONAL_RULES,
  ROBOTS_TOKEN,
  SCAN_LIMITS,
  USER_AGENT,
  gradeFor,
} from './methodology';
export { CRAWLER_POLICY } from './checks/crawlerAccess';
export { CATEGORY_LABELS } from './reportText';
export { GROUP_IDS, GROUP_LABELS, answerabilityChecks, pickTopFixes, scoreReport } from './scoring';
export {
  UnscannableTargetError,
  resolveTarget,
  type ResolvedTarget,
  type UnscannableReason,
} from './target/resolveTarget';
export { baseDomain, fingerprintFor, guessScope, normalizeSubmittedUrl, scopeKey } from './target/scope';
export { BlockedTargetError } from './transport/publicAddress';
export type * from './report.types';
