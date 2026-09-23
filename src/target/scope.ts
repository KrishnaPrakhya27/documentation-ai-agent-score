import { createHash } from 'crypto';

import { assertFetchableUrl } from '../transport/publicAddress';
import type { ContentProfile } from '../report.types';

/**
 * Turns a submitted URL into the docs scope a scan stays inside. Pure: no
 * network. `docs.example.com` keeps its host, `example.com/docs` keeps its
 * subtree, locale and version segments stay part of the root, and nothing is
 * ever widened to the whole registrable domain.
 */

const TRACKING_PARAMS = new Set([
  'gclid',
  'fbclid',
  'msclkid',
  'yclid',
  'igshid',
  'mc_cid',
  'mc_eid',
  '_hsenc',
  '_hsmi',
  'mkt_tok',
  'ref',
  'ref_src',
]);

const DOCS_ROOT_SEGMENTS = new Set([
  'docs',
  'doc',
  'documentation',
  'developers',
  'developer',
  'api',
  'reference',
  'guides',
  'learn',
  'manual',
  'help',
  'support',
  'kb',
  'knowledge-base',
  'knowledgebase',
  'hc',
  'help-center',
  'helpcenter',
  'wiki',
  'handbook',
  'faq',
]);

const DOCS_HOST_LABELS = new Set([
  'docs',
  'doc',
  'documentation',
  'developer',
  'developers',
  'help',
  'support',
  'kb',
  'knowledge',
  'knowledgebase',
  'learn',
  'guide',
  'guides',
  'wiki',
  'manual',
  'faq',
  'helpcenter',
]);

const HELP_CENTER_HOST_LABELS = new Set([
  'help',
  'support',
  'kb',
  'knowledge',
  'knowledgebase',
  'helpcenter',
  'faq',
  'customer',
  'customers',
]);

const HELP_CENTER_SEGMENTS = new Set([
  'help',
  'support',
  'hc',
  'kb',
  'knowledge-base',
  'knowledgebase',
  'help-center',
  'helpcenter',
  'faq',
]);

const LOCALE_SEGMENT =
  /^(en|de|fr|es|it|pt|ja|ko|zh|ru|nl|sv|da|fi|no|nb|pl|tr|cs|uk|ar|he|hi|id|vi|th)([-_][a-z]{2,4})?$/i;
const VERSION_SEGMENT =
  /^(v\d+(\.\d+)*|\d+(\.\d+)+|\d+\.x|latest|stable|next|current)$/i;

export interface ScopeGuess {
  entryUrl: URL;
  scopeRoot: URL;
  locale: string | null;
  version: string | null;
  /** True for a bare apex such as `example.com`, where docs may live elsewhere. */
  isApexRoot: boolean;
  /** The URL routed its content after `#/`, which agents cannot follow. */
  hashRouted: boolean;
}

/** Normalises what a person typed: adds https, drops tracking and fragments. */
export function normalizeSubmittedUrl(input: string): URL {
  const trimmed = input.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  const url = assertFetchableUrl(withScheme);

  url.hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  for (const name of [...url.searchParams.keys()]) {
    if (name.toLowerCase().startsWith('utm_') || TRACKING_PARAMS.has(name.toLowerCase())) {
      url.searchParams.delete(name);
    }
  }
  return url;
}

export function guessScope(entry: URL): ScopeGuess {
  const hashRouted = /^#!?\//.test(entry.hash);
  const entryUrl = new URL(entry.href);
  entryUrl.hash = '';

  const segments = entryUrl.pathname.split('/').filter(Boolean);
  const docsHost = DOCS_HOST_LABELS.has(subdomainLabel(entryUrl.hostname) ?? '');

  let rootLength = 0;
  if (!docsHost) {
    const docsIndex = segments.findIndex(
      (segment, index) => index <= 1 && DOCS_ROOT_SEGMENTS.has(segment.toLowerCase()),
    );
    if (docsIndex >= 0) rootLength = docsIndex + 1;
  }

  let locale: string | null = null;
  let version: string | null = null;
  while (rootLength < segments.length) {
    const segment = segments[rootLength];
    if (!locale && LOCALE_SEGMENT.test(segment)) locale = segment;
    else if (!version && VERSION_SEGMENT.test(segment)) version = segment;
    else break;
    rootLength++;
  }

  const scopeRoot = new URL(entryUrl.origin);
  scopeRoot.pathname = rootLength ? `/${segments.slice(0, rootLength).join('/')}` : '/';

  const labels = entryUrl.hostname.split('.');
  const isApexRoot =
    !docsHost &&
    rootLength === 0 &&
    segments.length === 0 &&
    (labels.length === 2 || (labels.length === 3 && labels[0] === 'www'));

  return { entryUrl, scopeRoot, locale, version, isApexRoot, hashRouted };
}

/** A locale code in the first three path segments, e.g. `en-us` in /hc/en-us/articles. */
export function localeInPath(url: URL): string | null {
  const segments = url.pathname.split('/').filter(Boolean).slice(0, 3);
  return segments.find((segment) => LOCALE_SEGMENT.test(segment))?.toLowerCase() ?? null;
}

/** Path-segment containment: `/docs` holds `/docs/x` but not `/docs-old`. */
export function isWithin(path: string, root: string): boolean {
  const base = root.replace(/\/+$/, '');
  return base === '' || path === base || path.startsWith(`${base}/`);
}

/** The leftmost label of a subdomain (`docs` in docs.example.com); none for `example.com`. */
function subdomainLabel(hostname: string): string | null {
  const labels = hostname.split('.');
  return labels.length >= 3 ? labels[0] : null;
}

/** The last two labels of a host, so docs.example.com and example.com count as one site. */
export function baseDomain(hostname: string): string {
  return hostname.replace(/^www\./, '').split('.').slice(-2).join('.');
}

/** `docs.example.com` or `example.com/docs`: the result page and badge key. */
export function scopeKey(scopeRoot: URL): string {
  const host = scopeRoot.hostname.replace(/^www\./, '');
  const path = scopeRoot.pathname.replace(/\/+$/, '');
  const port = scopeRoot.port ? `:${scopeRoot.port}` : '';
  return `${host}${port}${path}`;
}

export function scopeRootHref(scopeRoot: URL): string {
  return `${scopeRoot.origin}${scopeRoot.pathname.replace(/\/+$/, '')}`;
}

export function inferProfile(scopeRoot: URL): ContentProfile {
  if (HELP_CENTER_HOST_LABELS.has(subdomainLabel(scopeRoot.hostname) ?? '')) {
    return 'help-center';
  }
  const first = scopeRoot.pathname.split('/').filter(Boolean)[0]?.toLowerCase();
  if (first && HELP_CENTER_SEGMENTS.has(first)) return 'help-center';
  return 'developer-docs';
}

/** Where docs for a bare apex usually live, most likely first. */
export function apexCandidates(apex: URL): string[] {
  const host = apex.hostname.replace(/^www\./, '');
  return [
    `https://docs.${host}`,
    `https://${host}/docs`,
    `https://developers.${host}`,
    `https://developer.${host}`,
    `https://help.${host}`,
    `https://support.${host}`,
    `https://${host}/help`,
  ];
}

export interface FingerprintInput {
  scopeRoot: string;
  profile: ContentProfile;
  locale: string | null;
  version: string | null;
  methodologyVersion: string;
  engineVersion: string;
  afdocsVersion: string;
  samplePages: number;
  answerability: string;
}

/** Stable cache identity: a changed scope or methodology is a different report. */
export function fingerprintFor(input: FingerprintInput): string {
  const canonical = JSON.stringify(
    Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b))),
  );
  return createHash('sha256').update(canonical).digest('hex');
}
