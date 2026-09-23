import { classifyFetchError, type FetchFailureCode } from '../transport/errors';
import type { ScanHttpClient } from '../transport/guardedFetch';
import type { ContentProfile, ReportTarget } from '../report.types';
import {
  apexCandidates,
  guessScope,
  inferProfile,
  isWithin,
  localeInPath,
  normalizeSubmittedUrl,
  scopeKey,
  scopeRootHref,
} from './scope';

/**
 * Settles what a submission means before any scan is queued: follows the
 * entry URL's redirects, finds the docs for a bare apex, and refuses targets
 * that cannot be scanned with a reason a person can act on.
 */

export type UnscannableReason =
  | FetchFailureCode
  | 'not_found'
  | 'server_error'
  | 'not_html';

export class UnscannableTargetError extends Error {
  constructor(
    message: string,
    readonly reason: UnscannableReason,
  ) {
    super(message);
    this.name = 'UnscannableTargetError';
  }
}

export interface ResolvedTarget {
  target: ReportTarget;
  hashRouted: boolean;
  /** Set when a bare apex was resolved to the docs found at this URL. */
  detectedFrom: string | null;
}

export async function resolveTarget(
  submitted: string,
  http: ScanHttpClient,
  requestedProfile?: ContentProfile,
): Promise<ResolvedTarget> {
  const submittedUrl = normalizeSubmittedUrl(submitted);
  const guess = guessScope(submittedUrl);

  let entry = guess.entryUrl;
  let detectedFrom: string | null = null;
  if (guess.isApexRoot) {
    const docs = await findApexDocs(entry, http);
    if (docs) {
      detectedFrom = entry.href;
      entry = docs;
    }
  }

  const landed = await reachEntry(entry, http);
  const entryScope = guessScope(entry);
  const landedScope = guessScope(landed);
  const staysInScope =
    landed.origin === entryScope.scopeRoot.origin &&
    isWithin(landed.pathname, entryScope.scopeRoot.pathname);
  const scope = staysInScope ? entryScope : landedScope;
  // A root that redirects to /en-us/ tells us which locale to sample.
  const locale = scope.locale ?? (staysInScope ? localeInPath(landed) : null);

  return {
    target: {
      submittedUrl: submittedUrl.href,
      resolvedUrl: landed.href,
      scopeRoot: scopeRootHref(scope.scopeRoot),
      key: scopeKey(scope.scopeRoot),
      domain: scope.scopeRoot.hostname.replace(/^www\./, ''),
      profile: requestedProfile ?? inferProfile(scope.scopeRoot),
      locale,
      version: scope.version,
    },
    hashRouted: guess.hashRouted,
    detectedFrom,
  };
}

async function findApexDocs(apex: URL, http: ScanHttpClient): Promise<URL | null> {
  const probes = await Promise.allSettled(
    apexCandidates(apex).map(async (candidate) => {
      const response = await http.fetch(candidate);
      const type = response.headers.get('content-type') ?? '';
      return response.status === 200 && type.includes('html') ? new URL(response.url) : null;
    }),
  );
  for (const probe of probes) {
    if (probe.status === 'fulfilled' && probe.value) return probe.value;
  }
  return null;
}

async function reachEntry(entry: URL, http: ScanHttpClient): Promise<URL> {
  let response;
  try {
    response = await http.fetch(entry.href);
  } catch (error) {
    const reason = classifyFetchError(error);
    throw new UnscannableTargetError(describeFailure(entry, reason), reason);
  }

  // 401/403 are scanned: the report states the login wall or bot block.
  if (response.status === 404 || response.status === 410) {
    throw new UnscannableTargetError(
      `${entry.href} returned ${response.status}. Check the address and try again.`,
      'not_found',
    );
  }
  if (response.status >= 500) {
    throw new UnscannableTargetError(
      `${entry.hostname} answered with a server error (${response.status}). Try again later.`,
      'server_error',
    );
  }
  const type = response.headers.get('content-type') ?? '';
  if (response.status < 400 && type && !/html|markdown|text\/plain/i.test(type)) {
    throw new UnscannableTargetError(
      `${entry.href} is not a web page (${type.split(';')[0]}).`,
      'not_html',
    );
  }
  return new URL(response.url);
}

function describeFailure(entry: URL, reason: FetchFailureCode): string {
  switch (reason) {
    case 'blocked':
      return `${entry.hostname} is not a public website, so it cannot be scanned.`;
    case 'robots':
      return `${entry.hostname} asks crawlers not to read this page in its robots.txt, so we did not scan it.`;
    case 'dns':
      return `We could not find ${entry.hostname}. Check the spelling of the address.`;
    case 'timeout':
      return `${entry.hostname} took too long to answer. Try again in a moment.`;
    case 'tls':
      return `${entry.hostname} has a certificate problem, so we could not connect securely.`;
    case 'connection':
      return `${entry.hostname} refused the connection.`;
    case 'redirects':
      return `${entry.href} redirects too many times.`;
    default:
      return `We could not load ${entry.href}.`;
  }
}
