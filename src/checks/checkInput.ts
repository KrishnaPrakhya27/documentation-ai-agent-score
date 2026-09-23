import { classifyFetchError, type FetchFailureCode } from '../transport/errors';
import type { ScanHttpClient, ScanResponse } from '../transport/guardedFetch';
import type { RobotsPolicy } from '../transport/robotsPolicy';
import type { ReportTarget } from '../report.types';
import type { ParsedPage } from './pageContent';
import type { ScopeSitemap } from './sitemapIndex';

/** What every supplemental and Freshness check reads; built once per scan. */
export interface CheckInput {
  http: ScanHttpClient;
  robots: RobotsPolicy;
  target: ReportTarget;
  scopeRoot: URL;
  /** How AFDocs found its pages: llms-txt, sitemap or fallback. */
  discoverySources: string[];
  pages: ParsedPage[];
  llmsTxt: { url: string; content: string } | null;
  sitemap: Promise<ScopeSitemap>;
  now: number;
}

/** Enough to run the checks that do not wait for AFDocs. */
export type BaseCheckInput = Pick<CheckInput, 'http' | 'robots' | 'target' | 'scopeRoot'>;

export type FetchOutcome =
  | { response: ScanResponse; body: string }
  | { failure: FetchFailureCode };

/** Fetches through the scan transport, answering with the reason instead of throwing. */
export async function fetchText(
  input: Pick<CheckInput, 'http'>,
  url: string,
  headers?: Record<string, string>,
): Promise<FetchOutcome> {
  try {
    const response = await input.http.fetch(url, headers ? { headers } : undefined);
    return { response, body: await response.text() };
  } catch (error) {
    return { failure: classifyFetchError(error) };
  }
}

/** Plain-English reason a page could not be read, for a check's message. */
export function unreadableBecause(outcome: FetchOutcome): string {
  if ('response' in outcome) return `it answered ${outcome.response.status}`;
  switch (outcome.failure) {
    case 'robots':
      return 'robots.txt does not allow it';
    case 'deadline':
    case 'budget':
      return 'the scan reached its time or request limit first';
    case 'timeout':
      return 'it took too long to answer';
    default:
      return 'the request failed';
  }
}

export function uniqueUrls(urls: string[]): string[] {
  return [...new Set(urls.map((url) => url.replace(/\/+$/, '') || url))];
}
