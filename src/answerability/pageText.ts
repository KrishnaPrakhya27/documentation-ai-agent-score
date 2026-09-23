import { parse } from 'node-html-parser';
import TurndownService from 'turndown';
import { tables } from 'turndown-plugin-gfm';

/**
 * Page text as an agent receives it. Copied from AFDocs' helpers (MIT,
 * https://github.com/agent-ecosystem/afdocs) because its helpers entry also
 * loads a Vitest runner, which people installing this package do not have.
 * Keep in step with the pinned AFDOCS_VERSION.
 */

const HTML_PATTERNS = [/<!doctype\s/i, /<html[\s>]/i, /<head[\s>]/i, /<body[\s>]/i];

export function htmlToMarkdown(html: string): string {
  const root = parse(html);
  for (const element of root.querySelectorAll('script, style')) {
    element.remove();
  }
  const turndown = new TurndownService();
  turndown.use(tables);
  return turndown.turndown(root.toString());
}

/** True for an HTML document, ignoring tags that only appear inside code examples. */
export function looksLikeHtml(body: string): boolean {
  const sample = withoutCode(body).slice(0, 2000);
  return HTML_PATTERNS.some((pattern) => pattern.test(sample));
}

function withoutCode(text: string): string {
  return text.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\1[ \t]*$/gm, '').replace(/`[^`\n]+`/g, '``');
}
