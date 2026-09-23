import { parsePage } from '../checks/pageContent';
import { ANSWERABILITY_LIMITS } from '../methodology';
import type { ScanHttpClient } from '../transport/guardedFetch';
import type { PageRenderer, SourcePage } from './types';

/**
 * The pages questions are written from. Raw HTML text is used where there is
 * some; a page whose raw HTML is nearly empty is rendered in a browser once,
 * so a question can reveal an answer an agent never receives.
 */

const MIN_TEXT = 400;

export async function loadSourcePages(
  http: ScanHttpClient,
  urls: string[],
  renderer?: PageRenderer,
): Promise<SourcePage[]> {
  const pages: SourcePage[] = [];
  let renders = 0;

  for (const url of urls.slice(0, ANSWERABILITY_LIMITS.maxPagesForQuestions)) {
    let html: string;
    try {
      const response = await http.fetch(url);
      if (!response.ok) continue;
      html = await response.text();
    } catch {
      continue;
    }

    const parsed = parsePage(url, html);
    const title = parsed.root.querySelector('title')?.textContent.trim() ?? url;
    if (parsed.text.length >= MIN_TEXT) {
      pages.push({ url, title, text: parsed.text, needsJavaScript: false });
      continue;
    }

    if (renderer && renders < ANSWERABILITY_LIMITS.maxRenderedPages) {
      renders++;
      const rendered = await renderSafely(renderer, url);
      if (rendered && rendered.length >= MIN_TEXT) {
        pages.push({ url, title, text: rendered, needsJavaScript: true });
      }
    }
  }
  return pages;
}

async function renderSafely(renderer: PageRenderer, url: string): Promise<string | null> {
  try {
    return await renderer(url);
  } catch {
    return null;
  }
}

/** Lowercase words only: how quotes and page text are compared. */
export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Whether an evidence quote really appears in a text, allowing small wording drift. */
export function containsQuote(text: string, quote: string): boolean {
  const haystack = normalizeForMatch(text);
  const needle = normalizeForMatch(quote);
  if (!needle) return false;
  if (haystack.includes(needle)) return true;

  const words = needle.split(' ');
  if (words.length < 5) return false;
  const vocabulary = new Set(haystack.split(' '));
  const present = words.filter((word) => vocabulary.has(word)).length;
  return present / words.length >= 0.85;
}
