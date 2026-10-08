import { createHash } from 'crypto';
import { parse as parseDomain } from 'tldts';

import { assertFetchableUrl } from '../transport/publicAddress';
import type { ContentProfile } from '../report.types';

/**
 * Turns a submitted URL into the scope a scan stays inside: exactly the page
 * or section that was submitted and everything under its path, as AFDocs
 * scopes a run. Pure: no network. A scope is never widened to the whole site
 * or moved to another host; only the entry URL's own redirects move it.
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

/** The submitted page or section, without its query or fragment, is the scope. */
export function guessScope(entry: URL): ScopeGuess {
  const hashRouted = /^#!?\//.test(entry.hash);
  const entryUrl = new URL(entry.href);
  entryUrl.hash = '';

  const segments = entryUrl.pathname.split('/').filter(Boolean);
  const scopeRoot = new URL(entryUrl.origin);
  scopeRoot.pathname = segments.length ? `/${segments.join('/')}` : '/';

  return {
    entryUrl,
    scopeRoot,
    locale: localeInPath(scopeRoot),
    version: segments.find((segment) => VERSION_SEGMENT.test(segment)) ?? null,
    hashRouted,
  };
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

/** The first label left of the registrable domain: `help` in help.example.co.uk; none for `example.com`. */
export function subdomainLabel(hostname: string): string | null {
  const subdomain = parseDomain(hostname).subdomain;
  return subdomain ? subdomain.split('.')[0] : null;
}

/**
 * The registrable domain from the Public Suffix List, so docs.example.co.uk and
 * example.co.uk count as one site while foo.readthedocs.io and
 * bar.readthedocs.io stay two.
 */
export function baseDomain(hostname: string): string {
  const host = hostname.replace(/^www\./, '');
  return parseDomain(host, { allowPrivateDomains: true }).domain ?? host;
}

/** `docs.example.com` or `example.com/docs`: the site key reports and caches are stored under. */
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
