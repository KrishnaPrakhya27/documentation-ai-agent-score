import { classifyFetchError, type FetchFailureCode } from '../transport/errors';
import type { ScanHttpClient } from '../transport/guardedFetch';
import type { ContentProfile, ReportTarget } from '../report.types';
import {
  baseDomain,
  guessScope,
  inferProfile,
  isWithin,
  localeInPath,
  normalizeSubmittedUrl,
  scopeKey,
  scopeRootHref,
  subdomainLabel,
} from './scope';

/**
 * Settles what a submission means before any scan is queued: follows the
 * entry URL's redirects, as an agent would, and refuses targets that cannot
 * be scanned with a reason a person can act on. What was submitted is what
 * gets scored; a bare domain is scored as itself, not swapped for its docs.
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
}

export async function resolveTarget(
  submitted: string,
  http: ScanHttpClient,
  requestedProfile?: ContentProfile,
): Promise<ResolvedTarget> {
  const submittedUrl = normalizeSubmittedUrl(submitted);
  const entryScope = guessScope(submittedUrl);

  const landed = await reachEntry(entryScope.entryUrl, http);
  const landedScope = guessScope(landed);
  const staysInScope =
    landed.origin === entryScope.scopeRoot.origin &&
    isWithin(landed.pathname, entryScope.scopeRoot.pathname);
  const scope = staysInScope ? entryScope : landedScope;
  // A root that redirects to /en-us/ tells us which locale to sample.
  const locale = scope.locale ?? (staysInScope ? localeInPath(landed) : null);
  const docsElsewhere = await findDocsElsewhere(submittedUrl, scope.scopeRoot, http);

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
      ...(docsElsewhere && { docsElsewhere }),
    },
    hashRouted: entryScope.hashRouted,
  };
}

/** Hosts whose first label already says "documentation", so no hint is needed. */
const DOCS_HOST_LABELS = new Set([
  'docs',
  'doc',
  'documentation',
  'developer',
  'developers',
  'dev',
  'help',
  'support',
  'kb',
  'knowledge',
  'learn',
  'api',
  'guide',
  'guides',
  'manual',
  'reference',
  'wiki',
]);

/**
 * When a bare domain was submitted, where its documentation seems to live:
 * `docs.<domain>` or `/docs`, whichever answers first as a web page other
 * than the home page. The scan still scores what was submitted; the report
 * offers this address as the one to scan for a docs-only score.
 */
export async function findDocsElsewhere(
  submitted: URL,
  scopeRoot: URL,
  http: ScanHttpClient,
): Promise<string | undefined> {
  if (submitted.pathname !== '/' || scopeRoot.pathname !== '/') return undefined;
  if (DOCS_HOST_LABELS.has(subdomainLabel(scopeRoot.hostname) ?? '')) return undefined;
  const domain = baseDomain(scopeRoot.hostname);
  for (const candidate of [`https://docs.${domain}/`, `${scopeRoot.origin}/docs`]) {
    try {
      const response = await http.fetch(candidate);
      const type = response.headers.get('content-type') ?? '';
      if (response.status !== 200 || !/html|markdown/i.test(type)) continue;
      const landed = new URL(response.url);
      const isHomePage =
        landed.origin === scopeRoot.origin && landed.pathname.replace(/\/+$/, '') === '';
      if (isHomePage || baseDomain(landed.hostname) !== domain) continue;
      return docsKey(new URL(candidate), landed);
    } catch {
      // Not there, not allowed, or not reachable in time: no hint.
    }
  }
  return undefined;
}

/**
 * The address to suggest: the candidate itself when it answers on its own
 * host (docs.example.com, even if it lands on an intro page), or, when it
 * redirects to another host, that host's docs section (example.com/docs).
 */
function docsKey(candidate: URL, landed: URL): string {
  if (landed.origin === candidate.origin) return scopeKey(guessScope(candidate).scopeRoot);
  const section = landed.pathname.split('/').filter(Boolean)[0];
  return scopeKey(guessScope(new URL(section ? `/${section}` : '/', landed.origin)).scopeRoot);
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
    case 'robots_unreachable':
      return `${entry.hostname} did not let us read its robots.txt just now, so we did not scan it. Try again in a moment.`;
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
