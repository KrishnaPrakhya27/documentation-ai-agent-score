import { parse } from 'node-html-parser';

import { classifyFetchError } from '../transport/errors';
import type { ReportCheck } from '../report.types';
import type { CheckInput } from './checkInput';
import { endpointMentions, specOperation, type EndpointMention } from './openapi';
import { ourCheck, statusForCredit } from './ourCheck';
import {
  anchorIds,
  contentReferences,
  declaredUpdateDate,
  pageKey,
  toDate,
  type ParsedPage,
} from './pageContent';
import { pickEvenly } from './sitemapIndex';

/**
 * Freshness: whether the docs are maintained and consistent with their
 * sources. Maintenance is what a scan can see on its own (dates, links and
 * anchors, the sitemap); consistency and currency compare the docs with the
 * published API spec, and only count when a spec exists. A check that could
 * not run says so instead of scoring zero.
 */

const LINK_LIMITS = { internal: 30, external: 15, perHost: 3, hosts: 8, anchors: 15, sitemap: 10 };
const SKIPPED_EXTENSIONS = /\.(png|jpe?g|gif|svg|webp|ico|zip|gz|tgz|mp4|mov|woff2?)$/i;
/** Enough of a page to read its ids without downloading a whole reference page. */
const ANCHOR_PAGE_BYTES = 512 * 1024;
/** Fragments that are not section ids: hash routing and text fragments. */
const NOT_A_SECTION = /^([/!?]|:~:)/;

interface Verdict {
  state: 'ok' | 'broken' | 'unverified';
  detail: string;
}

interface Reference {
  url: string;
  fragment: string | null;
  from: string;
}

export async function checkLinksAndAnchors(input: CheckInput): Promise<ReportCheck> {
  const references = collectReferences(input.pages);
  if (references.length === 0) {
    return ourCheck('links-and-anchors', 'skip', null, 'The sampled pages carry no links to check.');
  }

  const known = new Map(input.pages.map((page) => [pageKey(page.url), page]));
  const linkTargets = chooseLinkTargets(references, input.scopeRoot.origin);
  const linkVerdicts = new Map<string, Verdict>();
  await Promise.all(
    linkTargets.map(async (url) => {
      linkVerdicts.set(url, known.has(pageKey(url)) ? { state: 'ok', detail: 'sampled page' } : await checkLink(input, url));
    }),
  );

  const anchorRefs = references
    .filter((reference) => reference.fragment && !NOT_A_SECTION.test(reference.fragment))
    .filter((reference) => new URL(reference.url).origin === input.scopeRoot.origin)
    .slice(0, LINK_LIMITS.anchors);
  const anchorCache = new Map<string, Promise<Set<string> | Verdict>>();
  const anchorVerdicts = await Promise.all(
    anchorRefs.map(async (reference) => ({
      reference,
      verdict: await checkAnchor(input, reference, known, linkVerdicts, anchorCache),
    })),
  );

  const links = linkTargets.map((url) => ({ label: url, from: sourceOf(references, url), verdict: linkVerdicts.get(url) as Verdict }));
  const anchors = anchorVerdicts.map(({ reference, verdict }) => ({
    label: `${reference.url}#${reference.fragment}`,
    from: reference.from,
    verdict,
  }));
  const all = [...links, ...anchors];
  const checked = all.filter((entry) => entry.verdict.state !== 'unverified');
  const broken = checked.filter((entry) => entry.verdict.state === 'broken');
  const unverified = all.length - checked.length;

  if (checked.length === 0) {
    return ourCheck(
      'links-and-anchors',
      'unverified',
      null,
      `None of the ${all.length} links on the sampled pages could be verified (timeouts, blocked requests or the scan's limits).`,
    );
  }

  const credit = (checked.length - broken.length) / checked.length;
  const rate = broken.length / checked.length;
  const brokenLinks = broken.filter((entry) => links.includes(entry)).length;
  const brokenAnchors = broken.length - brokenLinks;
  const unverifiedNote = unverified
    ? ` ${unverified} more could not be verified (timeouts or blocked requests) and ${unverified === 1 ? 'is' : 'are'} not counted.`
    : '';
  const anchorsChecked = anchors.filter((entry) => entry.verdict.state !== 'unverified').length;
  const linksChecked = checked.length - anchorsChecked;

  return ourCheck(
    'links-and-anchors',
    broken.length === 0 ? 'pass' : rate <= 0.05 ? 'warn' : 'fail',
    credit,
    broken.length === 0
      ? `All ${linksChecked} links${anchorsChecked ? ` and ${anchorsChecked} section anchors` : ''} checked on the sampled pages work.${unverifiedNote}`
      : `${broken.length} of ${checked.length} references checked on the sampled pages are broken: ${brokenLinks} link${brokenLinks === 1 ? '' : 's'}${brokenAnchors ? ` and ${brokenAnchors} section anchor${brokenAnchors === 1 ? '' : 's'}` : ''}.${unverifiedNote}`,
    broken.length
      ? 'Fix or remove the broken links, redirect moved pages to their new address, and restore or retarget section anchors. Agents follow links to gather context, and a dead link ends that path.'
      : undefined,
    broken.slice(0, 5).map((entry) => `${entry.label} (${entry.verdict.detail}) linked from ${entry.from}`),
  );
}

function collectReferences(pages: ParsedPage[]): Reference[] {
  const seen = new Set<string>();
  const references: Reference[] = [];
  for (const page of pages) {
    for (const reference of contentReferences(page)) {
      if (SKIPPED_EXTENSIONS.test(new URL(reference.url).pathname)) continue;
      const key = `${reference.url}#${reference.fragment ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      references.push({ ...reference, from: page.url });
    }
  }
  return references;
}

/** Up to 30 links on the site and 15 elsewhere, spread across hosts, in the order found. */
function chooseLinkTargets(references: Reference[], origin: string): string[] {
  const internal: string[] = [];
  const external: string[] = [];
  const perHost = new Map<string, number>();
  for (const url of [...new Set(references.map((reference) => reference.url))]) {
    const parsed = new URL(url);
    if (parsed.origin === origin) {
      if (internal.length < LINK_LIMITS.internal) internal.push(url);
      continue;
    }
    const count = perHost.get(parsed.host) ?? 0;
    if (
      external.length < LINK_LIMITS.external &&
      count < LINK_LIMITS.perHost &&
      (count > 0 || perHost.size < LINK_LIMITS.hosts)
    ) {
      perHost.set(parsed.host, count + 1);
      external.push(url);
    }
  }
  return [...internal, ...external];
}

function sourceOf(references: Reference[], url: string): string {
  return references.find((reference) => reference.url === url)?.from ?? url;
}

async function checkLink(input: Pick<CheckInput, 'http'>, link: string): Promise<Verdict> {
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

/** Whether the section a `#fragment` names exists on its page: a sampled page, or one read for the purpose. */
async function checkAnchor(
  input: CheckInput,
  reference: Reference,
  known: Map<string, ParsedPage>,
  linkVerdicts: Map<string, Verdict>,
  cache: Map<string, Promise<Set<string> | Verdict>>,
): Promise<Verdict> {
  const fragment = reference.fragment as string;
  if (fragment === 'top') return { state: 'ok', detail: 'top of page' };

  const sampled = known.get(pageKey(reference.url));
  const ids = sampled ? sampled.anchors : await anchorsOf(input, reference.url, linkVerdicts, cache);
  if (!(ids instanceof Set)) return ids;
  return ids.has(fragment)
    ? { state: 'ok', detail: 'section found' }
    : { state: 'broken', detail: 'no such section' };
}

async function anchorsOf(
  input: CheckInput,
  url: string,
  linkVerdicts: Map<string, Verdict>,
  cache: Map<string, Promise<Set<string> | Verdict>>,
): Promise<Set<string> | Verdict> {
  const linkVerdict = linkVerdicts.get(url);
  if (linkVerdict && linkVerdict.state !== 'ok') return linkVerdict;
  let pending = cache.get(url);
  if (!pending) {
    pending = (async () => {
      try {
        const response = await input.http.fetch(url, { maxBytes: ANCHOR_PAGE_BYTES });
        if (response.status === 404 || response.status === 410) return { state: 'broken', detail: String(response.status) } as Verdict;
        if (response.status >= 400) return { state: 'unverified', detail: String(response.status) } as Verdict;
        return anchorIds(parse(await response.text()));
      } catch (error) {
        return { state: 'unverified', detail: classifyFetchError(error) } as Verdict;
      }
    })();
    cache.set(url, pending);
  }
  return pending;
}

export async function checkUpdateInfo(input: CheckInput): Promise<ReportCheck> {
  if (input.pages.length === 0) {
    return ourCheck('update-info', 'skip', null, 'No pages could be read.');
  }

  const sitemap = await input.sitemap;
  const lastmods = new Map(sitemap.inScope.map((entry) => [pageKey(entry.loc), entry.lastmod]));
  let onPage = 0;
  let inSitemapOnly = 0;
  for (const page of input.pages) {
    if (declaredUpdateDate(page)) onPage++;
    else if (toDate(lastmods.get(pageKey(page.url)))) inSitemapOnly++;
  }

  const credit = (onPage + inSitemapOnly * 0.5) / input.pages.length;
  const sitemapText = inSitemapOnly
    ? `, and ${inSitemapOnly} more ha${inSitemapOnly === 1 ? 's' : 've'} a date only in the sitemap`
    : '';
  return ourCheck(
    'update-info',
    statusForCredit(credit, { pass: 0.8, warn: 0.5 }),
    credit,
    `${onPage} of ${input.pages.length} sampled pages state when they were last changed${sitemapText}.`,
    credit >= 0.8
      ? undefined
      : 'Publish a last-modified date on every page: as article:modified_time or dateModified in the page, a visible "Last updated" line, or a Last-Modified header. Agents can then tell how current a page is; the date itself is not judged.',
  );
}

export async function checkSitemapLive(input: CheckInput): Promise<ReportCheck> {
  const sitemap = await input.sitemap;
  if (!sitemap.url || sitemap.inScope.length === 0) {
    return ourCheck('sitemap-live', 'skip', null, 'No sitemap entries for these docs to check.');
  }

  const sampled = new Set(input.pages.map((page) => pageKey(page.url)));
  const candidates = pickEvenly(
    sitemap.inScope.map((entry) => entry.loc).filter((loc) => !sampled.has(pageKey(loc))),
    LINK_LIMITS.sitemap,
  );
  if (candidates.length === 0) {
    return ourCheck('sitemap-live', 'pass', 1, 'Every sitemap entry for these docs is a page the scan read.');
  }

  const verdicts = await Promise.all(candidates.map(async (url) => ({ url, verdict: await checkLink(input, url) })));
  const verified = verdicts.filter((entry) => entry.verdict.state !== 'unverified');
  if (verified.length === 0) {
    return ourCheck(
      'sitemap-live',
      'unverified',
      null,
      `None of the ${candidates.length} sitemap entries sampled could be verified (timeouts, blocked requests or the scan's limits).`,
    );
  }
  const dead = verified.filter((entry) => entry.verdict.state === 'broken');
  const credit = (verified.length - dead.length) / verified.length;
  return ourCheck(
    'sitemap-live',
    dead.length === 0 ? 'pass' : credit >= 0.9 ? 'warn' : 'fail',
    credit,
    dead.length === 0
      ? `All ${verified.length} sitemap entries sampled still exist.`
      : `${dead.length} of ${verified.length} sitemap entries sampled no longer exist.`,
    dead.length
      ? 'Remove deleted pages from the sitemap, or redirect them. A sitemap that lists missing pages sends agents and crawlers to errors.'
      : undefined,
    dead.slice(0, 5).map((entry) => `${entry.url} (${entry.verdict.detail})`),
  );
}

export async function checkApiSpecMatch(input: CheckInput): Promise<ReportCheck> {
  const spec = await input.openApi;
  if (!spec) {
    return ourCheck('api-spec-match', 'skip', null, 'No OpenAPI description was found, so the docs could not be compared with a spec.');
  }
  const mentioned = [...new Set(endpointMentions(input.pages).map((mention) => mention.operation))];
  if (mentioned.length === 0) {
    return ourCheck(
      'api-spec-match',
      'skip',
      null,
      `Found ${spec.url}, but the sampled pages mention no endpoints to compare against it.`,
      undefined,
      [spec.url],
    );
  }

  const missing = mentioned.filter((operation) => specOperation(spec, operation) === null);
  const credit = (mentioned.length - missing.length) / mentioned.length;
  return ourCheck(
    'api-spec-match',
    statusForCredit(credit, { pass: 1, warn: 0.8 }),
    credit,
    missing.length === 0
      ? `All ${mentioned.length} endpoints mentioned on the sampled pages are in ${spec.url}.`
      : `${missing.length} of ${mentioned.length} endpoints mentioned in the docs are not in ${spec.url}.`,
    missing.length
      ? 'Update either the docs or the OpenAPI file so they describe the same endpoints. Agents trust the spec when generating code, and a mismatch produces calls that fail.'
      : undefined,
    [spec.url, ...missing.slice(0, 5)],
  );
}

const DEPRECATION_NOTICE =
  /deprecat|no longer (?:supported|available|recommended|maintained)|sunset|retired|legacy|will be removed|use [^.]{0,60} instead/i;

export async function checkDeprecationNotices(input: CheckInput): Promise<ReportCheck> {
  const spec = await input.openApi;
  if (!spec) {
    return ourCheck('deprecation-notices', 'skip', null, 'No OpenAPI description was found, so deprecation notices could not be compared with a spec.');
  }
  if (spec.deprecated.size === 0) {
    return ourCheck('deprecation-notices', 'skip', null, `${spec.url} marks no operation as deprecated, so there is nothing to compare.`, undefined, [spec.url]);
  }

  const uses = new Map<string, EndpointMention & { spec: string }>();
  for (const mention of endpointMentions(input.pages)) {
    const operation = specOperation(spec, mention.operation);
    if (!operation || !spec.deprecated.has(operation)) continue;
    const key = `${mention.page} ${operation}`;
    const existing = uses.get(key);
    // Keep the mention whose surroundings carry the notice, if any does.
    if (!existing || (!DEPRECATION_NOTICE.test(existing.context) && DEPRECATION_NOTICE.test(mention.context))) {
      uses.set(key, { ...mention, spec: operation });
    }
  }
  if (uses.size === 0) {
    return ourCheck(
      'deprecation-notices',
      'skip',
      null,
      `The sampled pages do not use any of the ${spec.deprecated.size} operations ${spec.url} marks deprecated.`,
      undefined,
      [spec.url],
    );
  }

  const silent = [...uses.values()].filter((use) => !DEPRECATION_NOTICE.test(use.context));
  const credit = (uses.size - silent.length) / uses.size;
  return ourCheck(
    'deprecation-notices',
    statusForCredit(credit, { pass: 1, warn: 0.5 }),
    credit,
    silent.length === 0
      ? `All ${uses.size} uses of deprecated operations on the sampled pages say the operation is deprecated.`
      : `${silent.length} of ${uses.size} uses of deprecated operations on the sampled pages do not say so.`,
    silent.length
      ? 'Where the docs use an operation the spec marks deprecated, say it is deprecated next to it and point to the replacement, so an agent does not recommend it.'
      : undefined,
    silent.slice(0, 5).map((use) => `${use.spec} on ${use.page}`),
  );
}
