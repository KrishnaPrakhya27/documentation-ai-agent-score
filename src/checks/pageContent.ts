import { parse, type HTMLElement } from 'node-html-parser';

/**
 * Reads what the checks need out of a fetched HTML page: the article text,
 * the links inside it and any last-updated date the page declares.
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
}

export function parsePage(url: string, html: string): ParsedPage {
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
  return { url, root, content, text: collapse(content.textContent), jsonLd };
}

/** Absolute http(s) links in the article, without fragments, de-duplicated. */
export function contentLinks(page: ParsedPage): string[] {
  const links = new Set<string>();
  for (const anchor of page.content.querySelectorAll('a[href]')) {
    const href = anchor.getAttribute('href')?.trim();
    if (!href || href.startsWith('#')) continue;
    if (/^(mailto|tel|javascript|data):/i.test(href)) continue;
    try {
      const url = new URL(href, page.url);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
      url.hash = '';
      links.add(url.href);
    } catch {
      // Unparseable hrefs are not links an agent can follow either.
    }
  }
  return [...links];
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
  return null;
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
