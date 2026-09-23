import { parse as parseYaml } from 'yaml';

import { classifyFetchError } from '../transport/errors';
import type { ReportCheck } from '../report.types';
import { fetchText, unreadableBecause, type CheckInput } from './checkInput';
import { contentLinks, datesIn, declaredUpdateDate, toDate } from './pageContent';

/**
 * Freshness and integrity: broken links, declared update dates, changelog
 * recency and endpoints the docs mention that the OpenAPI file lacks. An old
 * date alone never fails a page; a missing signal is reported as missing.
 */

export interface ScoredCheck {
  check: ReportCheck;
  /** 0-100, or null when the check does not apply to this site. */
  score: number | null;
}

const DAY_MS = 86_400_000;
const LINK_LIMITS = { internal: 30, external: 15, perHost: 3, hosts: 8 };
const SKIPPED_EXTENSIONS = /\.(png|jpe?g|gif|svg|webp|ico|zip|gz|tgz|mp4|mov|woff2?)$/i;

type LinkVerdict = 'ok' | 'broken' | 'unverified';

export async function checkBrokenLinks(input: CheckInput): Promise<ScoredCheck> {
  const sources = new Map<string, string>();
  for (const page of input.pages) {
    for (const link of contentLinks(page)) {
      if (!sources.has(link) && !SKIPPED_EXTENSIONS.test(new URL(link).pathname)) {
        sources.set(link, page.url);
      }
    }
  }

  const known = new Set(input.pages.map((page) => page.url));
  const internal: string[] = [];
  const external: string[] = [];
  const perHost = new Map<string, number>();
  for (const link of sources.keys()) {
    const url = new URL(link);
    if (url.origin === input.scopeRoot.origin) {
      if (internal.length < LINK_LIMITS.internal) internal.push(link);
      continue;
    }
    const count = perHost.get(url.host) ?? 0;
    if (
      external.length < LINK_LIMITS.external &&
      count < LINK_LIMITS.perHost &&
      (count > 0 || perHost.size < LINK_LIMITS.hosts)
    ) {
      perHost.set(url.host, count + 1);
      external.push(link);
    }
  }

  const verdicts = await Promise.all(
    [...internal, ...external].map(async (link) => ({
      link,
      verdict: known.has(link)
        ? { state: 'ok' as const, detail: 'sampled page' }
        : await checkLink(input, link),
    })),
  );
  const broken = verdicts.filter((entry) => entry.verdict.state === 'broken');
  const checked = verdicts.filter((entry) => entry.verdict.state !== 'unverified');

  if (checked.length === 0) {
    return {
      score: null,
      check: freshnessCheck('broken-links', 'link-health', 'skip', 'No links on the sampled pages could be checked.'),
    };
  }

  const score = Math.round(((checked.length - broken.length) / checked.length) * 100);
  const rate = broken.length / checked.length;
  const status = broken.length === 0 ? 'pass' : rate <= 0.05 ? 'warn' : 'fail';
  const evidence = broken
    .slice(0, 5)
    .map((entry) => `${entry.link} (${entry.verdict.detail}) — linked from ${sources.get(entry.link)}`);

  return {
    score,
    check: freshnessCheck(
      'broken-links',
      'link-health',
      status,
      broken.length === 0
        ? `All ${checked.length} links checked on the sampled pages work.`
        : `${broken.length} of ${checked.length} links checked on the sampled pages are broken.`,
      broken.length
        ? 'Fix or remove the broken links, and redirect moved pages to their new address. Agents follow links to gather context, and a dead link ends that path.'
        : undefined,
      evidence,
    ),
  };
}

async function checkLink(
  input: CheckInput,
  link: string,
): Promise<{ state: LinkVerdict; detail: string }> {
  try {
    let response = await input.http.fetch(link, { method: 'HEAD' });
    // Some servers mishandle HEAD, so a 404 is confirmed with a GET too.
    if ([403, 404, 405, 410, 501].includes(response.status)) {
      response = await input.http.fetch(link, { maxBytes: 16 * 1024 });
    }
    if (response.status === 404 || response.status === 410) {
      return { state: 'broken', detail: String(response.status) };
    }
    if (response.status < 400) return { state: 'ok', detail: String(response.status) };
    return { state: 'unverified', detail: String(response.status) };
  } catch (error) {
    const reason = classifyFetchError(error);
    return reason === 'dns'
      ? { state: 'broken', detail: 'host not found' }
      : { state: 'unverified', detail: reason };
  }
}

export async function checkUpdateDates(input: CheckInput): Promise<ScoredCheck> {
  if (input.pages.length === 0) {
    return {
      score: null,
      check: freshnessCheck('last-updated-dates', 'recency', 'skip', 'No pages could be read.'),
    };
  }

  const sitemap = await input.sitemap;
  const lastmods = new Map(sitemap.inScope.map((entry) => [withoutSlash(entry.loc), entry.lastmod]));
  const onPage: number[] = [];
  const inSitemapOnly: number[] = [];
  for (const page of input.pages) {
    const declared = declaredUpdateDate(page);
    const fallback = declared ? null : toDate(lastmods.get(withoutSlash(page.url)));
    const date = declared ?? fallback;
    if (!date) continue;
    const age = Math.max(0, (input.now - date.getTime()) / DAY_MS);
    (declared ? onPage : inSitemapOnly).push(age);
  }

  const ages = [...onPage, ...inSitemapOnly].sort((a, b) => a - b);
  const credit = (onPage.length + inSitemapOnly.length * 0.5) / input.pages.length;
  const median = ages.length ? ages[Math.floor(ages.length / 2)] : null;
  const agePenalty = median === null ? 1 : median <= 365 ? 1 : median <= 730 ? 0.85 : 0.7;
  const score = Math.round(credit * 100 * agePenalty);
  const status = score >= 80 ? 'pass' : score >= 50 ? 'warn' : 'fail';

  const sitemapText = inSitemapOnly.length
    ? `; ${inSitemapOnly.length} more ha${inSitemapOnly.length === 1 ? 's' : 've'} a date only in the sitemap`
    : '';
  const ageText = median === null ? '' : ` (median ${describeAge(median)})`;
  return {
    score,
    check: freshnessCheck(
      'last-updated-dates',
      'recency',
      status,
      `${onPage.length} of ${input.pages.length} sampled pages show when they were last updated${sitemapText}${ageText}.`,
      status === 'pass'
        ? undefined
        : 'Show a last-updated date on every page and publish it as article:modified_time or dateModified, so agents can tell current guidance from old guidance.',
    ),
  };
}

function withoutSlash(url: string): string {
  return url.split('#')[0].replace(/\/+$/, '');
}

const CHANGELOG_PATH =
  /\/(changelog|change-log|release-notes|releasenotes|releases|whats-new|what-s-new|updates|release-history)(\/|$|\.)/i;

export async function checkChangelog(input: CheckInput): Promise<ScoredCheck> {
  const candidate = findChangelog(input);
  if (!candidate) {
    return {
      score: null,
      check: freshnessCheck(
        'changelog-recency',
        'recency',
        'skip',
        'No changelog or release notes were linked from the docs, so recency was not scored.',
        'Publish a dated changelog and link it from your docs navigation and llms.txt, so agents can see what changed and when.',
      ),
    };
  }

  const result = await fetchText(input, candidate);
  if (!('response' in result) || result.response.status !== 200) {
    return {
      score: null,
      check: freshnessCheck(
        'changelog-recency',
        'recency',
        'skip',
        `The changelog at ${candidate} could not be read because ${unreadableBecause(result)}.`,
      ),
    };
  }

  const text = result.body.replace(/<[^>]+>/g, ' ');
  const newest = datesIn(text, input.now)[0];
  if (!newest) {
    return {
      score: 40,
      check: freshnessCheck(
        'changelog-recency',
        'recency',
        'warn',
        `The changelog at ${result.response.url} has no dates an agent can read.`,
        'Put a date on every changelog entry, in the text of the page.',
        [result.response.url],
      ),
    };
  }

  const ageDays = (input.now - newest.getTime()) / DAY_MS;
  const status = ageDays <= 90 ? 'pass' : ageDays <= 365 ? 'warn' : 'fail';
  return {
    score: status === 'pass' ? 100 : status === 'warn' ? 60 : 20,
    check: freshnessCheck(
      'changelog-recency',
      'recency',
      status,
      `The latest changelog entry is from ${newest.toISOString().slice(0, 10)} (${describeAge(ageDays)}).`,
      status === 'pass'
        ? undefined
        : 'Keep the changelog current. An old last entry makes agents doubt whether the rest of the docs still apply.',
      [result.response.url],
    ),
  };
}

function findChangelog(input: CheckInput): string | null {
  const baseHost = input.scopeRoot.hostname.split('.').slice(-2).join('.');
  const links = new Set<string>();
  for (const page of input.pages) {
    for (const anchor of page.root.querySelectorAll('a[href]')) {
      try {
        links.add(new URL(anchor.getAttribute('href') ?? '', page.url).href.split('#')[0]);
      } catch {
        // ignore unparseable links
      }
    }
  }
  for (const match of input.llmsTxt?.content.matchAll(/\((https?:\/\/[^)\s]+)\)/g) ?? []) {
    links.add(match[1]);
  }

  return (
    [...links]
      .filter((link) => {
        const url = new URL(link);
        return (
          (url.hostname === baseHost || url.hostname.endsWith(`.${baseHost}`)) &&
          CHANGELOG_PATH.test(url.pathname)
        );
      })
      .sort((a, b) => changelogRank(a) - changelogRank(b) || a.length - b.length)[0] ?? null
  );
}

function changelogRank(link: string): number {
  if (/changelog|change-log/i.test(link)) return 0;
  if (/release-notes|releasenotes/i.test(link)) return 1;
  return 2;
}

export async function checkOpenApiDrift(input: CheckInput): Promise<ScoredCheck> {
  const mentions = endpointMentions(input);
  const spec = await loadOpenApi(input);

  if (!spec) {
    return {
      score: null,
      check: freshnessCheck('openapi-drift', 'recency', 'skip', 'No OpenAPI description was found, so endpoint coverage was not checked.'),
    };
  }
  if (mentions.size === 0) {
    return {
      score: null,
      check: freshnessCheck(
        'openapi-drift',
        'recency',
        'skip',
        `Found ${spec.url}, but the sampled pages mention no endpoints to compare against it.`,
        undefined,
        [spec.url],
      ),
    };
  }

  const missing = [...mentions].filter((mention) => !specHas(spec, mention));
  const score = Math.max(0, 100 - missing.length * 15);
  const status = missing.length === 0 ? 'pass' : missing.length <= 2 ? 'warn' : 'fail';
  return {
    score,
    check: freshnessCheck(
      'openapi-drift',
      'recency',
      status,
      missing.length === 0
        ? `All ${mentions.size} endpoints mentioned on the sampled pages are in ${spec.url}.`
        : `${missing.length} of ${mentions.size} endpoints mentioned in the docs are not in ${spec.url}.`,
      missing.length
        ? 'Update either the docs or the OpenAPI file so they describe the same endpoints. Agents trust the spec when generating code, and a mismatch produces calls that fail.'
        : undefined,
      [spec.url, ...missing.slice(0, 5)],
    ),
  };
}

interface OpenApiSpec {
  url: string;
  operations: Set<string>;
  basePaths: string[];
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const MENTION = /\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[A-Za-z0-9_\-./{}:<>]+)/g;

function endpointMentions(input: CheckInput): Set<string> {
  const mentions = new Set<string>();
  for (const page of input.pages) {
    for (const match of page.text.matchAll(MENTION)) {
      mentions.add(`${match[1]} ${normalizeApiPath(match[2])}`);
    }
  }
  return mentions;
}

function normalizeApiPath(path: string): string {
  return (
    path
      .replace(/[.,;:)]+$/, '')
      .replace(/\{[^}]*\}|<[^>]*>|:[A-Za-z_]\w*/g, '{}')
      .replace(/\/+$/, '') || '/'
  );
}

function specHas(spec: OpenApiSpec, mention: string): boolean {
  if (spec.operations.has(mention)) return true;
  const [method, path] = mention.split(' ');
  return spec.basePaths.some(
    (base) => base && path.startsWith(`${base}/`) && spec.operations.has(`${method} ${path.slice(base.length)}`),
  );
}

async function loadOpenApi(input: CheckInput): Promise<OpenApiSpec | null> {
  const linked = new Set<string>();
  const specLink = /https?:\/\/[^\s)"'<>]+(?:openapi|swagger)[^\s)"'<>/]*\.(?:json|ya?ml)\b/gi;
  for (const match of input.llmsTxt?.content.matchAll(specLink) ?? []) linked.add(match[0]);
  for (const page of input.pages) {
    for (const link of contentLinks(page)) {
      if (/(openapi|swagger)[^/]*\.(json|ya?ml)$/i.test(link)) linked.add(link);
    }
  }
  const candidates = [
    ...linked,
    `${input.target.scopeRoot}/openapi.json`,
    `${input.target.scopeRoot}/api-reference/openapi.json`,
    `${input.scopeRoot.origin}/openapi.json`,
  ].slice(0, 5);

  for (const url of [...new Set(candidates)]) {
    const result = await fetchText(input, url, {
      accept: 'application/json, application/yaml, text/yaml',
    });
    if (!('response' in result) || result.response.status !== 200 || result.response.truncated) {
      continue;
    }
    const spec = parseSpec(result.body);
    if (spec) return { url: result.response.url, ...spec };
  }
  return null;
}

function parseSpec(body: string): Omit<OpenApiSpec, 'url'> | null {
  let document: { paths?: Record<string, Record<string, unknown>>; servers?: Array<{ url?: string }> };
  try {
    document = body.trimStart().startsWith('{') ? JSON.parse(body) : parseYaml(body);
  } catch {
    return null;
  }
  if (!document || typeof document !== 'object' || !document.paths) return null;

  const operations = new Set<string>();
  for (const [path, item] of Object.entries(document.paths)) {
    for (const method of METHODS) {
      if (item && typeof item === 'object' && method in item) {
        operations.add(`${method.toUpperCase()} ${normalizeApiPath(path)}`);
      }
    }
  }
  const basePaths = (document.servers ?? [])
    .map((server) => {
      try {
        return new URL(server.url ?? '', 'https://placeholder.invalid').pathname.replace(/\/+$/, '');
      } catch {
        return '';
      }
    })
    .filter(Boolean);
  return operations.size ? { operations, basePaths } : null;
}

function describeAge(days: number): string {
  if (days < 1) return 'today';
  if (days < 45) return `${Math.round(days)} days ago`;
  if (days < 540) return `${Math.round(days / 30)} months ago`;
  return `${(days / 365).toFixed(1)} years ago`;
}

const TITLES: Record<string, string> = {
  'broken-links': 'Links on the page work',
  'last-updated-dates': 'Pages show when they were last updated',
  'changelog-recency': 'Changelog is recent',
  'openapi-drift': 'Docs match the OpenAPI file',
};

function freshnessCheck(
  id: string,
  group: 'link-health' | 'recency',
  status: ReportCheck['status'],
  message: string,
  fix?: string,
  evidence?: string[],
): ReportCheck {
  return {
    id,
    pillar: 'freshness',
    group,
    title: TITLES[id],
    status,
    scored: status !== 'skip',
    source: 'agent-score',
    message,
    ...(fix && { fix }),
    ...(evidence?.length && { evidence }),
  };
}
