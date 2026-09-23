import { afdocsChecks } from './afdocs/afdocsChecks';
import {
  llmsTxtFrom,
  runAfdocs,
  type AfdocsRun,
  type AfdocsSample,
} from './afdocs/runAfdocs';
import { checkAgentSkills, checkLlmsFullTxt, checkMcpServer } from './checks/agentProtocols';
import type { BaseCheckInput, CheckInput } from './checks/checkInput';
import { checkRobotsAiAccess, checkSitemap } from './checks/crawlerAccess';
import {
  checkBrokenLinks,
  checkChangelog,
  checkOpenApiDrift,
  checkUpdateDates,
} from './checks/freshness';
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
import type {
  AgentScoreReport,
  AnswerabilityResult,
  ReportCheck,
  ReportTarget,
} from './report.types';
import { buildFixPrompt, siteName } from './reportText';
import {
  HELP_CENTER_SCORED_CHECKS,
  overallScore,
  pickTopFixes,
  scoreAccess,
  scoreFreshness,
} from './scoring';
import { GuardedFetcher, type GuardedFetcherOptions } from './transport/guardedFetch';

/**
 * The fast half of a scan: AFDocs, the supplemental protocol checks and
 * Freshness, assembled into a `technical` report with Answerability pending.
 * Runs against a deadline and returns partial evidence rather than hanging.
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
      checkRobotsAiAccess(base),
    ]);

    // Page checks start as soon as AFDocs has picked its sample and then share
    // the origin's request budget with the AFDocs checks still running.
    let announceSample!: (sample: AfdocsSample) => void;
    const sampleReady = new Promise<AfdocsSample>((resolve) => {
      announceSample = resolve;
    });
    const runChecksAndAnnounce = async () => {
      const run = await runAfdocsWithFallback(input.target, fetcher, scopeSitemap, announceSample);
      // Fewer than five pages never announced a sample; start from what AFDocs ended with.
      announceSample(sampleOf(run));
      return run;
    };
    const runPageChecksWhenSampled = async () =>
      runPageChecks(await sampleReady, { ...base, fetcher, sitemap: scopeSitemap }, input, now);
    const afdocsDone = runChecksAndAnnounce();
    const pageStage = runPageChecksWhenSampled();

    const [afdocs, page, [llmsFull, skills, robots]] = await Promise.all([
      afdocsDone,
      pageStage,
      early,
    ]);
    const { target, platform, parsed } = page;
    const profile = target.profile;

    const checks = applyProfile(
      [
        ...afdocsChecks(afdocs),
        robots,
        page.sitemap,
        llmsFull,
        page.mcp,
        skills,
        page.links.check,
        page.dates.check,
        page.changelog.check,
        page.openapi.check,
      ],
      profile,
    );

    const access = scoreAccess(afdocs, profile, checks);
    const freshness = scoreFreshness(
      page.links,
      [page.dates, page.changelog, page.openapi],
      checks.find((check) => check.id === 'markdown-content-parity'),
    );
    const answerability: AnswerabilityResult = input.answerabilityPlanned
      ? { state: 'pending', score: null, passed: 0, total: 0, transcript: [] }
      : {
          state: 'unavailable',
          score: null,
          passed: 0,
          total: 0,
          transcript: [],
          reason:
            input.answerabilityUnavailableReason ?? 'Answerability was not tested for this scan.',
        };
    const pillars = { access, answerability, freshness };
    const stats = fetcher.stats();

    const report: AgentScoreReport = {
      schemaVersion: 1,
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
      overall: overallScore(pillars),
      pillars,
      checks,
      topFixes: pickTopFixes(checks, afdocs, freshness, profile),
      fixPrompt: '',
      coverage: {
        pagesDiscovered: afdocs.totalPages,
        pagesTested: afdocs.sampledUrls.length,
        sampledUrls: afdocs.sampledUrls,
        discoverySources: afdocs.report.discoverySources ?? [],
        requests: stats.requests,
      },
      limitations: limitationsFor(
        input,
        afdocs.sampledUrls.length,
        stats.robotsBlocked.length,
        checks,
      ),
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
  const platform = detectPlatform({ pages });
  const profile =
    !input.profileChosen && isHelpCenterPlatform(platform.id) ? 'help-center' : input.target.profile;
  const target: ReportTarget = { ...input.target, profile };

  const parsed = pages.map((page) => parsePage(page.url, page.html));
  const sampled = parsed.filter((page) => sample.sampledUrls.includes(page.url));
  const checkInput: CheckInput = {
    http: base.http,
    robots: base.robots,
    scopeRoot: base.scopeRoot,
    target,
    discoverySources: sample.discoverySources,
    pages: sampled.length ? sampled : parsed,
    llmsTxt: sample.llmsTxt,
    sitemap: base.sitemap,
    now: now(),
  };

  const [mcp, sitemap, links, dates, changelog, openapi] = await Promise.all([
    checkMcpServer(checkInput),
    checkSitemap(checkInput),
    checkBrokenLinks(checkInput),
    checkUpdateDates(checkInput),
    checkChangelog(checkInput),
    checkOpenApiDrift(checkInput),
  ]);
  return { target, platform, parsed, mcp, sitemap, links, dates, changelog, openapi };
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
  onSampled: (sample: AfdocsSample) => void,
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
    { onSampled, minPages: 5 },
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
    { onSampled, minPages: 1 },
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
): Promise<Array<{ url: string; html: string }>> {
  const unique = [...new Set(urls)];
  const pages = await Promise.all(
    unique.map(async (url) => {
      try {
        const response = await fetcher.fetch(url);
        const type = response.headers.get('content-type') ?? '';
        if (!response.ok || !type.includes('html')) return null;
        return { url, html: await response.text() };
      } catch {
        return null;
      }
    }),
  );
  return pages.filter((page): page is { url: string; html: string } => page !== null);
}

/** Help centres are scored on a subset; the rest stay visible as information. */
function applyProfile(checks: ReportCheck[], profile: string): ReportCheck[] {
  if (profile !== 'help-center') return checks;
  return checks.map((check) =>
    check.pillar === 'access'
      ? { ...check, scored: HELP_CENTER_SCORED_CHECKS.has(check.id) && check.scored !== false }
      : check,
  );
}

function limitationsFor(
  input: TechnicalAssessmentInput,
  pagesTested: number,
  robotsBlocked: number,
  checks: ReportCheck[],
): string[] {
  const notes = [
    `Based on ${pagesTested} sampled page${pagesTested === 1 ? '' : 's'}, chosen deterministically from the sitemap and llms.txt. Pages outside the sample were not read.`,
    'Pages were fetched without running JavaScript, the way most AI agents read the web.',
  ];
  if (pagesTested < 5) {
    notes.push('Fewer than five pages could be sampled, so page-level results are indicative only.');
  }
  if (input.hashRouted) {
    notes.push('The submitted URL routes content after "#/", which agents cannot follow, so only the landing page was reachable.');
  }
  if (robotsBlocked > 0) {
    notes.push(`robots.txt stopped the scanner from reading ${robotsBlocked} URL${robotsBlocked === 1 ? '' : 's'}; checks that needed them are incomplete.`);
  }
  if (checks.some((check) => check.status === 'error')) {
    notes.push('Some checks could not finish (a timeout or a request limit); they are excluded from the score rather than counted as failures.');
  }
  return notes;
}
