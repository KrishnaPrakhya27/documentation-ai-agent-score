import type { AnswerabilityModels } from './answerability/types';
import { runAnswerability } from './answerability/runAnswerability';
import { createScanFetcher, runTechnicalAssessment } from './assess';
import { finalizeReport } from './finalize';
import { SCAN_LIMITS } from './methodology';
import type { AgentScoreReport, ContentProfile } from './report.types';
import { type ResolvedTarget, resolveTarget } from './target/resolveTarget';

/**
 * A whole scan in one call: find the docs behind a URL, run the technical
 * checks, and, when models are given, the Answerability test. This is what
 * the CLI runs; hosts that split the stages across jobs call them directly.
 */

export interface ScanSiteOptions {
  /** Answerability models. Leave out for a scan of Access and Freshness only. */
  models?: AnswerabilityModels | null;
  /** Scores as a help center or as developer docs instead of inferring it. */
  profile?: ContentProfile;
  /** Link to this report used in its fix prompt; defaults to the public report page. */
  reportUrl?: string;
  /** Short progress lines, for a terminal or a log. */
  onProgress?: (message: string) => void;
}

export interface ScanSiteResult {
  report: AgentScoreReport;
  /** Estimated model spend for Answerability in US dollars; 0 when it did not run. */
  answerabilityCostUsd: number;
}

export function publicReportUrl(siteKey: string): string {
  return `https://documentation.ai/agent-score/${siteKey}`;
}

export async function scanSite(url: string, options: ScanSiteOptions = {}): Promise<ScanSiteResult> {
  const { models, profile, onProgress } = options;
  const resolved = await resolveSubmittedUrl(url, profile);
  onProgress?.(`Scanning ${resolved.target.key} (${resolved.target.profile})`);

  const reportUrl = options.reportUrl ?? publicReportUrl(resolved.target.key);
  const technical = await runTechnicalAssessment({
    target: resolved.target,
    profileChosen: !!profile,
    hashRouted: resolved.hashRouted,
    reportUrl,
    answerabilityPlanned: !!models,
    answerabilityUnavailableReason: 'Answerability was not tested in this scan. Run it with --ai <provider> and your own API key.',
  });
  if (!models) return { report: technical.report, answerabilityCostUsd: 0 };

  onProgress?.('Technical checks done; testing answers');
  const run = await runAnswerability(
    { target: technical.report.target, sampledUrls: technical.sampledUrls },
    { models },
  );
  return { report: finalizeReport(technical.report, run.result, reportUrl), answerabilityCostUsd: run.costUsd };
}

async function resolveSubmittedUrl(url: string, profile?: ContentProfile): Promise<ResolvedTarget> {
  const resolver = createScanFetcher(Date.now() + SCAN_LIMITS.resolveDeadlineMs, {
    maxRequests: SCAN_LIMITS.resolveRequestBudget,
  });
  try {
    return await resolveTarget(url, resolver, profile);
  } finally {
    await resolver.close();
  }
}
