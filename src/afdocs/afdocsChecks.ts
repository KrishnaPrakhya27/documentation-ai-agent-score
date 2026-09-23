import type { CheckResult } from 'afdocs';

import type { ReportCheck } from '../report.types';
import type { AfdocsRun } from './runAfdocs';

/**
 * Presents AFDocs results as report checks: short titles, the category as the
 * group, and AFDocs' own fix text with its CLI-only advice removed.
 */

export const AFDOCS_TITLES: Record<string, string> = {
  'llms-txt-exists': 'llms.txt exists',
  'llms-txt-valid': 'llms.txt follows the standard structure',
  'llms-txt-size': "llms.txt fits in an agent's context",
  'llms-txt-links-resolve': 'llms.txt links work',
  'llms-txt-links-markdown': 'llms.txt links point to Markdown',
  'llms-txt-directive-html': 'Pages point agents to llms.txt',
  'llms-txt-directive-md': 'Markdown pages point agents to llms.txt',
  'markdown-url-support': 'Pages are available as Markdown',
  'content-negotiation': 'Server returns Markdown when asked',
  'rendering-strategy': 'Content is in the HTML without JavaScript',
  'page-size-markdown': 'Markdown pages fit in context',
  'page-size-html': 'HTML pages fit in context',
  'content-start-position': 'Content starts near the top',
  'tabbed-content-serialization': "Tabs don't bloat the page",
  'section-header-quality': 'Headings inside tabs name their variant',
  'markdown-code-fence-validity': 'Code blocks are well-formed',
  'http-status-codes': 'Missing pages return a real 404',
  'redirect-behavior': 'Redirects stay on the same host',
  'llms-txt-coverage': 'llms.txt covers the whole site',
  'markdown-content-parity': 'Markdown matches the HTML page',
  'cache-header-hygiene': 'Cache headers allow timely updates',
  'auth-gate-detection': 'Docs are readable without logging in',
  'auth-alternative-access': 'Gated docs offer another way in',
};

export function afdocsChecks(run: AfdocsRun): ReportCheck[] {
  return run.report.results.map((result) => {
    const fix = cleanResolution(run.score.resolutions[result.id]);
    const evidence = problemPages(result);
    return {
      id: result.id,
      pillar: 'access',
      group: result.category,
      title: AFDOCS_TITLES[result.id] ?? result.id,
      status: result.status,
      scored: result.status !== 'skip' && result.status !== 'error',
      source: 'afdocs',
      message: result.message,
      ...(fix && result.status !== 'pass' && { fix }),
      ...(evidence.length && { evidence }),
    };
  });
}

/** Drops sentences that only make sense for someone running the AFDocs CLI. */
export function cleanResolution(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const kept = text
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !/--[a-z]|afdocs|config file/i.test(sentence));
  return kept.join(' ').trim() || undefined;
}

function problemPages(result: CheckResult): string[] {
  const pages = (result.details as { pageResults?: Array<{ url?: string; status?: string }> })
    ?.pageResults;
  if (!Array.isArray(pages) || result.status === 'pass') return [];
  return pages
    .filter((page) => page.url && page.status && page.status !== 'pass')
    .slice(0, 3)
    .map((page) => page.url as string);
}
