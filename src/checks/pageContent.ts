import { parse, type HTMLElement } from 'node-html-parser';

/**
 * Reads what the checks need out of a fetched HTML page: the article text,
 * the links and section references inside it, the ids a link can point at,
 * and any last-updated date the page declares.
 */

const CONTENT_SELECTORS = [
  'main article',
  'article',
  'main',
  '[role="main"]',
  '#content',
  '.content',
];

const MONTHS =
  'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';

export const DATE_PATTERNS = [
  /\b(20\d\d-\d{2}-\d{2})(?:[T ][\d:.]+Z?)?\b/g,
  new RegExp(`\\b(${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+20\\d\\d\\b`, 'gi'),
  new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(${MONTHS})\\.?,?\\s+20\\d\\d\\b`, 'gi'),
];

export interface ParsedPage {
  url: string;
  root: HTMLElement;
  content: HTMLElement;
  text: string;
  /** JSON-LD blocks, read before scripts are stripped from the tree. */
  jsonLd: string[];
  /** Every id and anchor name on the page: what a `#fragment` link can land on. */
  anchors: Set<string>;
  /** The response's Last-Modified header, when the server sent one. */
  lastModified: Date | null;
}

export interface PageHeaders {
  lastModified?: string | null;
}

export function parsePage(url: string, html: string, headers: PageHeaders = {}): ParsedPage {
  const root = parse(html);
  const jsonLd = root
    .querySelectorAll('script[type="application/ld+json"]')
    .map((script) => script.rawText);
  for (const node of root.querySelectorAll('script, style, noscript, template, svg')) {
    node.remove();
  }
  const content =
    CONTENT_SELECTORS.map((selector) => root.querySelector(selector)).find(Boolean) ??
    root.querySelector('body') ??
    root;
  return {
    url,
    root,
    content,
    text: collapse(content.textContent),
    jsonLd,
    anchors: anchorIds(root),
    lastModified: toDate(headers.lastModified),
  };
}

/** Every `id` and `<a name>` on the page, as a fragment link would spell it. */
export function anchorIds(root: HTMLElement): Set<string> {
  const ids = new Set<string>();
  for (const node of root.querySelectorAll('[id]')) {
    const id = node.getAttribute('id')?.trim();
    if (id) ids.add(id);
  }
  for (const node of root.querySelectorAll('a[name]')) {
    const name = node.getAttribute('name')?.trim();
    if (name) ids.add(name);
  }
  return ids;
}

/** A link in the article, split into the page it points at and the section on it, if any. */
export interface ContentReference {
  /** Absolute http(s) URL without the fragment. */
  url: string;
  fragment: string | null;
}

/** Every link in the article an agent could follow, including links to a section of the same page. */
export function contentReferences(page: ParsedPage): ContentReference[] {
  const seen = new Set<string>();
  const references: ContentReference[] = [];
  for (const anchor of page.content.querySelectorAll('a[href]')) {
    const href = anchor.getAttribute('href')?.trim();
    if (!href) continue;
    if (/^(mailto|tel|javascript|data):/i.test(href)) continue;
    try {
      const url = new URL(href, page.url);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
      const fragment = decodeFragment(url.hash);
      url.hash = '';
      const key = `${url.href}#${fragment ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      references.push({ url: url.href, fragment });
    } catch {
      // Unparseable hrefs are not links an agent can follow either.
    }
  }
  return references;
}

/** Absolute http(s) links in the article, without fragments, de-duplicated. */
export function contentLinks(page: ParsedPage): string[] {
  return [...new Set(contentReferences(page).map((reference) => reference.url))];
}

function decodeFragment(hash: string): string | null {
  const raw = hash.replace(/^#/, '');
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * One document, however it was linked: no scheme, no www, no `.md` twin, no
 * trailing slash, no query or fragment. What sitemap coverage and page
 * identity compare on.
 */
export function pageKey(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname
      .replace(/\/index\.mdx?$/, '')
      .replace(/\.mdx?$/, '')
      .replace(/\/+$/, '');
    return `${parsed.hostname.replace(/^www\./, '').toLowerCase()}${path}`;
  } catch {
    return url;
  }
}

/** The page's declared last-updated date, most reliable source first. */
export function declaredUpdateDate(page: ParsedPage): Date | null {
  const metaNames = [
    'meta[property="article:modified_time"]',
    'meta[property="og:updated_time"]',
    'meta[name="last-modified"]',
    'meta[name="dcterms.modified"]',
    'meta[name="revised"]',
    'meta[itemprop="dateModified"]',
  ];
  for (const selector of metaNames) {
    const date = toDate(page.root.querySelector(selector)?.getAttribute('content'));
    if (date) return date;
  }

  for (const block of page.jsonLd) {
    const match = /"dateModified"\s*:\s*"([^"]+)"/.exec(block);
    const date = toDate(match?.[1]);
    if (date) return date;
  }

  const updatedText = /(last\s+updated|last\s+modified|updated\s+on|updated)[:\s]+([^.\n|]{6,40})/i.exec(
    page.text,
  );
  const fromText = updatedText ? firstDateIn(updatedText[2]) : null;
  if (fromText) return fromText;

  for (const time of page.content.querySelectorAll('time[datetime]')) {
    const date = toDate(time.getAttribute('datetime'));
    if (date) return date;
  }
  return page.lastModified;
}

export function firstDateIn(text: string): Date | null {
  return datesIn(text)[0] ?? null;
}

/** Every plausible date in a text, newest first, ignoring the future. */
export function datesIn(text: string, now = Date.now()): Date[] {
  const found: Date[] = [];
  for (const pattern of DATE_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const date = toDate(match[0]);
      if (date && date.getTime() <= now + 86_400_000) found.push(date);
    }
  }
  return found.sort((a, b) => b.getTime() - a.getTime());
}

export function toDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const cleaned = value.trim().replace(/(\d)(st|nd|rd|th)/i, '$1');
  const time = Date.parse(cleaned);
  if (Number.isNaN(time)) return null;
  const year = new Date(time).getUTCFullYear();
  return year >= 1995 && year <= 2100 ? new Date(time) : null;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
