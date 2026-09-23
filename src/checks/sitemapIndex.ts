import type { ScanHttpClient } from '../transport/guardedFetch';
import type { RobotsPolicy } from '../transport/robotsPolicy';
import { isWithin } from '../target/scope';

/**
 * Reads the sitemap entries that fall inside the docs scope, with their
 * lastmod dates, following index files a short way. Shared by the sitemap
 * check, the update-date fallback and page sampling when AFDocs finds none.
 */

export interface SitemapEntry {
  loc: string;
  lastmod: string | null;
}

export interface ScopeSitemap {
  /** The first sitemap document that parsed, if any. */
  url: string | null;
  inScope: SitemapEntry[];
}

const MAX_ENTRIES = 5_000;
const MAX_CHILDREN = 5;

export async function loadScopeSitemap(
  http: ScanHttpClient,
  robots: RobotsPolicy,
  scopeRoot: string,
): Promise<ScopeSitemap> {
  const root = new URL(`${scopeRoot}/`);
  const candidates = [
    ...(await declaredSitemaps(robots, root.origin)).slice(0, 3),
    `${scopeRoot}/sitemap.xml`,
    `${root.origin}/sitemap.xml`,
  ];

  let firstFound: string | null = null;
  for (const candidate of [...new Set(candidates)]) {
    const entries = await readSitemap(http, candidate, 2, root);
    if (!entries) continue;
    firstFound ??= candidate;
    const inScope = entries.filter((entry) => entryInScope(entry.loc, root));
    if (inScope.length > 0) return { url: candidate, inScope };
  }
  return { url: firstFound, inScope: [] };
}

async function declaredSitemaps(robots: RobotsPolicy, origin: string): Promise<string[]> {
  try {
    return (await robots.fileFor(origin)).parser?.getSitemaps() ?? [];
  } catch {
    return [];
  }
}

async function readSitemap(
  http: ScanHttpClient,
  url: string,
  depth: number,
  root: URL,
): Promise<SitemapEntry[] | null> {
  let body: string;
  try {
    const response = await http.fetch(url);
    if (response.status !== 200) return null;
    body = await response.text();
  } catch {
    return null;
  }
  if (!/<(urlset|sitemapindex)[\s>]/.test(body)) return null;

  const { entries, children } = parseSitemapEntries(body);
  if (depth === 0 || children.length === 0) return entries;

  // Children whose own URL mentions the docs path are the likeliest to hold it.
  const rootPath = root.pathname.replace(/\/+$/, '');
  const ordered = [...children].sort(
    (a, b) => Number(!!rootPath && b.includes(rootPath)) - Number(!!rootPath && a.includes(rootPath)),
  );
  const nested: SitemapEntry[] = [...entries];
  for (const child of ordered.slice(0, MAX_CHILDREN)) {
    const childEntries = await readSitemap(http, child, depth - 1, root);
    if (childEntries) nested.push(...childEntries);
    if (nested.length >= MAX_ENTRIES) break;
  }
  return nested.slice(0, MAX_ENTRIES);
}

export function parseSitemapEntries(xml: string): {
  entries: SitemapEntry[];
  children: string[];
} {
  const entries: SitemapEntry[] = [];
  for (const block of xml.matchAll(/<url>([\s\S]*?)<\/url>/gi)) {
    const loc = /<loc>\s*([^<\s]+)\s*<\/loc>/i.exec(block[1])?.[1];
    if (!loc) continue;
    const lastmod = /<lastmod>\s*([^<\s]+)\s*<\/lastmod>/i.exec(block[1])?.[1] ?? null;
    entries.push({ loc: decodeXml(loc), lastmod });
    if (entries.length >= MAX_ENTRIES) break;
  }
  const children = [...xml.matchAll(/<sitemap>[\s\S]*?<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(
    (match) => decodeXml(match[1]),
  );
  return { entries, children };
}

/** Every Nth entry of the sorted list, so the same site always yields the same sample. */
export function pickEvenly(urls: string[], count: number): string[] {
  const sorted = [...new Set(urls)].sort();
  if (sorted.length <= count) return sorted;
  const stride = sorted.length / count;
  return Array.from({ length: count }, (_, index) => sorted[Math.floor(index * stride)]);
}

function entryInScope(loc: string, root: URL): boolean {
  try {
    const url = new URL(loc);
    return (
      url.hostname.replace(/^www\./, '') === root.hostname.replace(/^www\./, '') &&
      isWithin(url.pathname, root.pathname)
    );
  } catch {
    return false;
  }
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}
