import { afdocsChecks, summarizeAfdocs } from './afdocs/afdocsChecks';
import {
  llmsTxtFrom,
  runAfdocs,
  type AfdocsHooks,
  type AfdocsRun,
  type AfdocsSample,
} from './afdocs/runAfdocs';
import { emptyAnswerability } from './answerability/runAnswerability';
import { checkAgentSkills, checkLlmsFullTxt, checkMcpServer } from './checks/agentProtocols';
import type { BaseCheckInput, CheckInput } from './checks/checkInput';
import { checkCrawlerPermissions, checkSitemapCoverage } from './checks/crawlerAccess';
import {
  checkApiSpecMatch,
  checkDeprecationNotices,
  checkLinksAndAnchors,
  checkSitemapLive,
  checkUpdateInfo,
} from './checks/freshness';
import { loadOpenApi } from './checks/openapi';
import { parsePage } from './checks/pageContent';
import { detectPlatform, isHelpCenterPlatform } from './checks/platform';
import { loadScopeSitemap, pickEvenly, type ScopeSitemap } from './checks/sitemapIndex';
import {
  AFDOCS_VERSION,
  ENGINE_VERSION,
  METHODOLOGY_VERSION,
  ROBOTS_TOKEN,
  SCAN_LIMITS,
  USER_AGENT,
} from './methodology';
import type { AgentScoreReport, OverallScore, ReportCheck, ReportTarget } from './report.types';
import { buildFixPrompt, siteName } from './reportText';
import { pickTopFixes, provisionalLimitation, scoreReport } from './scoring';
import { type FetchStats, GuardedFetcher, type GuardedFetcherOptions } from './transport/guardedFetch';

/**
 * The fast half of a scan: AFDocs, our access checks and Freshness, plus the
 * additional interfaces reported outside the score, assembled into a
 * `technical` report with Answerability pending. Runs against a deadline
 * and returns partial evidence rather than hanging.
 */

export interface TechnicalAssessmentInput {
  target: ReportTarget;
  /** Whether the profile came from the person rather than from inference. */
  profileChosen?: boolean;
  hashRouted?: boolean;
  /** Public URL of this report, for the fix prompt. */
  reportUrl: string;
  /** False when Answerability will not run at all for this scan. */
  answerabilityPlanned: boolean;
  answerabilityUnavailableReason?: string;
}

export interface EngineOptions {
  now?: () => number;
  fetcher?: Partial<GuardedFetcherOptions>;
  /** Short messages as the scan moves on, for showing progress. */
  onProgress?: (message: string) => void;
}

export interface TechnicalAssessment {
  report: AgentScoreReport;
  /** Pages Answerability should draw its questions from. */
  sampledUrls: string[];
}

export async function runTechnicalAssessment(
  input: TechnicalAssessmentInput,
  options: EngineOptions = {},
): Promise<TechnicalAssessment> {
  const now = options.now ?? Date.now;
  const startedAt = new Date(now()).toISOString();
  const fetcher = createScanFetcher(now() + SCAN_LIMITS.technicalDeadlineMs, options.fetcher);

  try {
    const scopeRoot = new URL(`${input.target.scopeRoot}/`);
    const base = { http: fetcher, robots: fetcher.robots, target: input.target, scopeRoot };
    const scopeSitemap = loadScopeSitemap(fetcher, fetcher.robots, input.target.scopeRoot);
    const early = Promise.all([
      checkLlmsFullTxt(base),
      checkAgentSkills(base),
      checkCrawlerPermissions(base),
    ]);

    // Page checks start as soon as AFDocs has picked its sample and then share
    // the origin's request budget with the AFDocs checks still running.
    let announceSample!: (sample: AfdocsSample) => void;
    const sampleReady = new Promise<AfdocsSample>((resolve) => {
      announceSample = resolve;
    });
    const progress = options.onProgress;
    let pageChecksNote = '';
    progress?.('Reading llms.txt, robots.txt and the sitemap');
    const runChecksAndAnnounce = async () => {
      const run = await runAfdocsWithFallback(input.target, fetcher, scopeSitemap, {
        onSampled: announceSample,
        onCheckDone: (done, total) => progress?.(`Running the agent checks: ${done} of ${total} done${pageChecksNote}`),
      });
      // Fewer than five pages never announced a sample; start from what AFDocs ended with.
      announceSample(sampleOf(run));
      progress?.('Agent checks done; finishing the page checks');
      return run;
    };
    const runPageChecksWhenSampled = async () => {
      const sample = await sampleReady;
      pageChecksNote = `, checking links and dates on ${sample.sampledUrls.length} sampled pages`;
      return runPageChecks(sample, { ...base, fetcher, sitemap: scopeSitemap }, input, now);
    };
    const afdocsDone = runChecksAndAnnounce();
    const pageStage = runPageChecksWhenSampled();

    const [afdocs, page, [llmsFull, skills, crawlers]] = await Promise.all([
      afdocsDone,
      pageStage,
      early,
    ]);
    const { target, platform, parsed } = page;

    const checks: ReportCheck[] = [
      ...afdocsChecks(afdocs),
      crawlers,
      page.sitemapCoverage,
      page.updateInfo,
      page.links,
      page.sitemapLive,
      page.apiSpec,
      page.deprecations,
    ];
    const additionalChecks = [page.mcp, llmsFull, skills];
    const answerability = input.answerabilityPlanned
      ? emptyAnswerability('pending')
      : emptyAnswerability(
          'unavailable',
          input.answerabilityUnavailableReason ?? 'Answerability was not tested for this scan.',
        );
    const stats = fetcher.stats();
    const coverage = {
      pagesDiscovered: afdocs.totalPages,
      pagesTested: afdocs.sampledUrls.length,
      sampledUrls: afdocs.sampledUrls,
      discoverySources: afdocs.report.discoverySources ?? [],
      requests: stats.requests,
      rateLimitedRequests: stats.rateLimited,
    };
    const afdocsSummary = summarizeAfdocs(afdocs);
    const { overall, groups } = scoreReport({ checks, afdocs: afdocsSummary, answerability, coverage });

    const report: AgentScoreReport = {
      schemaVersion: 2,
      methodology: {
        version: METHODOLOGY_VERSION,
        engineVersion: ENGINE_VERSION,
        afdocsVersion: AFDOCS_VERSION,
        specVersion: 'v0.5.0',
      },
      stage: input.answerabilityPlanned ? 'technical' : 'final',
      target,
      site: siteName(parsed, target.domain),
      platform,
      overall,
      afdocs: afdocsSummary,
      groups,
      answerability,
      checks,
      additionalChecks,
      topFixes: pickTopFixes(checks),
      fixPrompt: '',
      coverage,
      limitations: limitationsFor(input, coverage.pagesTested, stats, checks, overall),
      timings: {
        startedAt,
        technicalCompletedAt: new Date(now()).toISOString(),
        ...(!input.answerabilityPlanned && { completedAt: new Date(now()).toISOString() }),
      },
    };
    report.fixPrompt = buildFixPrompt(report, input.reportUrl);
    return { report, sampledUrls: afdocs.sampledUrls };
  } finally {
    await fetcher.close();
  }
}

/** Platform, profile and every check that reads the sampled pages. */
async function runPageChecks(
  sample: AfdocsSample,
  base: BaseCheckInput & { fetcher: GuardedFetcher; sitemap: Promise<ScopeSitemap> },
  input: TechnicalAssessmentInput,
  now: () => number,
) {
  const pages = await readPages(base.fetcher, [input.target.resolvedUrl, ...sample.sampledUrls]);
  const parsed = pages.map((page) => parsePage(page.url, page.html, { lastModified: page.lastModified }));
  const platform = detectPlatform({
    pages: pages.map((page, index) => ({ url: page.url, html: page.html, root: parsed[index].root })),
  });
  // The profile names the kind of site for the page and the fixes; it does not change the score.
  const profile =
    !input.profileChosen && isHelpCenterPlatform(platform.id) ? 'help-center' : input.target.profile;
  const target: ReportTarget = { ...input.target, profile };

  const sampled = parsed.filter((page) => sample.sampledUrls.includes(page.url));
  const pageSet = sampled.length ? sampled : parsed;
  const withoutSpec = {
    http: base.http,
    robots: base.robots,
    scopeRoot: base.scopeRoot,
    target,
    discoverySources: sample.discoverySources,
    pages: pageSet,
    llmsTxt: sample.llmsTxt,
    sitemap: base.sitemap,
    now: now(),
  };
  const checkInput: CheckInput = { ...withoutSpec, openApi: loadOpenApi(withoutSpec) };

  const [mcp, sitemapCoverage, links, updateInfo, sitemapLive, apiSpec, deprecations] = await Promise.all([
    checkMcpServer(checkInput),
    checkSitemapCoverage(checkInput),
    checkLinksAndAnchors(checkInput),
    checkUpdateInfo(checkInput),
    checkSitemapLive(checkInput),
    checkApiSpecMatch(checkInput),
    checkDeprecationNotices(checkInput),
  ]);
  return { target, platform, parsed, mcp, sitemapCoverage, links, updateInfo, sitemapLive, apiSpec, deprecations };
}

/**
 * AFDocs finds pages through llms.txt and root sitemaps. When that yields
 * fewer than five but the docs have their own in-scope sitemap (common for
 * help centres under a path), it runs again on pages picked from it.
 */
async function runAfdocsWithFallback(
  target: ReportTarget,
  fetcher: GuardedFetcher,
  scopeSitemap: Promise<ScopeSitemap>,
  hooks: Pick<AfdocsHooks, 'onSampled' | 'onCheckDone'>,
): Promise<AfdocsRun> {
  const options = {
    maxLinksToTest: SCAN_LIMITS.samplePages,
    requestTimeout: SCAN_LIMITS.requestTimeoutMs,
    ...(target.locale && { preferredLocale: target.locale }),
    ...(target.version && { preferredVersion: target.version }),
  };
  const first = await runAfdocs(
    target.scopeRoot,
    fetcher,
    { ...options, samplingStrategy: 'deterministic' },
    { ...hooks, minPages: 5 },
  );
  if (first.sampledUrls.length >= 5) return first;

  const sitemap = await scopeSitemap;
  if (sitemap.inScope.length < 5) return first;
  const curatedPages = pickEvenly(
    sitemap.inScope.map((entry) => entry.loc),
    SCAN_LIMITS.samplePages,
  );
  const second = await runAfdocs(
    target.scopeRoot,
    fetcher,
    { ...options, samplingStrategy: 'curated', curatedPages },
    { ...hooks, minPages: 1 },
  );
  return { ...second, totalPages: sitemap.inScope.length };
}

function sampleOf(run: AfdocsRun): AfdocsSample {
  return {
    sampledUrls: run.sampledUrls,
    totalPages: run.totalPages,
    discoverySources: run.report.discoverySources ?? [],
    llmsTxt: llmsTxtFrom(run.report.results.find((result) => result.id === 'llms-txt-exists')),
  };
}

export function createScanFetcher(
  deadline: number,
  overrides: Partial<GuardedFetcherOptions> = {},
): GuardedFetcher {
  return new GuardedFetcher({
    userAgent: USER_AGENT,
    robotsToken: ROBOTS_TOKEN,
    requestTimeoutMs: SCAN_LIMITS.requestTimeoutMs,
    maxBodyBytes: SCAN_LIMITS.maxBodyBytes,
    maxRedirects: SCAN_LIMITS.maxRedirects,
    minIntervalMs: SCAN_LIMITS.minIntervalMs,
    maxConcurrentPerOrigin: SCAN_LIMITS.maxConcurrentPerOrigin,
    maxRequests: SCAN_LIMITS.technicalRequestBudget,
    maxRetryAfterMs: SCAN_LIMITS.maxRetryAfterMs,
    deadline,
    ...overrides,
  });
}

async function readPages(
  fetcher: GuardedFetcher,
  urls: string[],
): Promise<Array<{ url: string; html: string; lastModified: string | null }>> {
  const unique = [...new Set(urls)];
  const pages = await Promise.all(
    unique.map(async (url) => {
      try {
        const response = await fetcher.fetch(url);
        const type = response.headers.get('content-type') ?? '';
        if (!response.ok || !type.includes('html')) return null;
        return { url, html: await response.text(), lastModified: response.headers.get('last-modified') };
      } catch {
        return null;
      }
    }),
  );
  return pages.filter((page): page is { url: string; html: string; lastModified: string | null } => page !== null);
}

function limitationsFor(
  input: TechnicalAssessmentInput,
  pagesTested: number,
  stats: FetchStats,
  checks: ReportCheck[],
  overall: OverallScore,
): string[] {
  const robotsBlocked = stats.robotsBlocked.length;
  const notes = [
    `Based on ${pagesTested} sampled page${pagesTested === 1 ? '' : 's'}, chosen deterministically from the sitemap and llms.txt. Pages outside the sample were not read.`,
    'Pages were fetched without running JavaScript, the way most AI agents read the web.',
  ];
  if (input.hashRouted) {
    notes.push('The submitted URL routes content after "#/", which agents cannot follow, so only the landing page was reachable.');
  }
  if (robotsBlocked > 0) {
    notes.push(`robots.txt stopped the scanner from reading ${robotsBlocked} URL${robotsBlocked === 1 ? '' : 's'}; checks that needed them are unverified.`);
  }
  if (checks.some((check) => check.status === 'unverified')) {
    notes.push('Some checks could not be verified (a timeout, a blocked request or a scan limit); they are left out of the score rather than counted as failures.');
  }
  const provisional = provisionalLimitation(overall);
  if (provisional) notes.push(provisional);
  return notes;
}
