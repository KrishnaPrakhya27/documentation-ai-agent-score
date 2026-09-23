import {
  computeScore,
  createContext,
  getChecksSorted,
  type CheckResult,
  type ReportResult,
  type RunnerOptions,
  type ScoreResult,
} from 'afdocs';

import type { ScanHttpClient } from '../transport/guardedFetch';

/**
 * Runs the pinned AFDocs checks with our guarded transport in place of its
 * global fetch. The loop mirrors AFDocs' own `runChecks` (MIT, agent-ecosystem/
 * afdocs 0.20.0, src/runner.ts) exactly, including its dependency rules;
 * `runChecks` itself offers no way to inject the HTTP client.
 */

export interface AfdocsRun {
  report: ReportResult;
  score: ScoreResult;
  sampledUrls: string[];
  totalPages: number;
}

/** What AFDocs has settled once it picks its sample, before its checks finish. */
export interface AfdocsSample {
  sampledUrls: string[];
  totalPages: number;
  discoverySources: string[];
  llmsTxt: { url: string; content: string } | null;
}

export interface AfdocsHooks {
  onCheckDone?: (checkId: string, elapsedMs: number) => void;
  /** Fires once, as soon as at least `minPages` pages are sampled. */
  onSampled?: (sample: AfdocsSample) => void;
  minPages?: number;
}

export async function runAfdocs(
  baseUrl: string,
  http: ScanHttpClient,
  options: Partial<RunnerOptions>,
  hooks: AfdocsHooks = {},
): Promise<AfdocsRun> {
  const ctx = createContext(baseUrl, options);
  ctx.http = http;
  let sampleAnnounced = false;
  const announceSample = () => {
    const sampled = ctx._sampledPages;
    if (sampleAnnounced || !hooks.onSampled || !sampled) return;
    if (sampled.urls.length < (hooks.minPages ?? 1)) return;
    sampleAnnounced = true;
    hooks.onSampled({
      sampledUrls: sampled.urls,
      totalPages: sampled.totalPages,
      discoverySources: sampled.sources ?? [],
      llmsTxt: llmsTxtFrom(ctx.previousResults.get('llms-txt-exists')),
    });
  };

  const results: CheckResult[] = [];
  for (const check of getChecksSorted()) {
    if (check.dependsOn.length > 0) {
      const groups = normalizeDependencies(check.dependsOn);
      const anyDependencyRan = groups.some((group) =>
        group.some((id) => ctx.previousResults.has(id)),
      );
      if (anyDependencyRan && !dependenciesMet(groups, ctx.previousResults)) {
        const skipped: CheckResult = {
          id: check.id,
          category: check.category,
          status: 'skip',
          message: 'Skipped: dependency check did not pass',
          dependsOn: groups.flat(),
        };
        results.push(skipped);
        ctx.previousResults.set(check.id, skipped);
        continue;
      }
    }

    let result: CheckResult;
    const started = Date.now();
    try {
      result = await check.run(ctx);
    } catch (error) {
      result = {
        id: check.id,
        category: check.category,
        status: 'error',
        message: `Check error: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    hooks.onCheckDone?.(check.id, Date.now() - started);
    results.push(result);
    ctx.previousResults.set(check.id, result);
    announceSample();
  }

  const count = (status: CheckResult['status']) =>
    results.filter((result) => result.status === status).length;
  const report: ReportResult = {
    url: ctx.baseUrl,
    timestamp: new Date().toISOString(),
    specUrl: 'https://agentdocsspec.com/spec/web/',
    results,
    summary: {
      total: results.length,
      pass: count('pass'),
      warn: count('warn'),
      fail: count('fail'),
      skip: count('skip'),
      error: count('error'),
    },
    ...(ctx._sampledPages?.sources && {
      discoverySources: ctx._sampledPages.sources,
    }),
    ...(ctx._sampledPages && { testedPages: ctx._sampledPages.urls.length }),
    samplingStrategy: ctx.options.samplingStrategy,
  };

  return {
    report,
    score: computeScore(report),
    sampledUrls: ctx._sampledPages?.urls ?? [],
    totalPages: ctx._sampledPages?.totalPages ?? 0,
  };
}

/** The llms.txt AFDocs chose as canonical, from its discovery details. */
export function llmsTxtFrom(
  result: CheckResult | undefined,
): { url: string; content: string } | null {
  const files = (result?.details as { discoveredFiles?: Array<{ url: string; content: string }> })
    ?.discoveredFiles;
  return files?.[0] ? { url: files[0].url, content: files[0].content } : null;
}

/** `['a','b']` means a AND b; `[['a','b']]` means a OR b. */
function normalizeDependencies(deps: string[][] | string[]): string[][] {
  if (deps.length === 0) return [];
  if (typeof deps[0] === 'string') return (deps as string[]).map((id) => [id]);
  return deps as string[][];
}

function dependenciesMet(
  groups: string[][],
  previous: Map<string, CheckResult>,
): boolean {
  return groups.every((group) =>
    group.some((id) => {
      const status = previous.get(id)?.status;
      return status === 'pass' || status === 'warn';
    }),
  );
}
