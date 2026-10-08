import type { ReportCheck } from '../report.types';
import { isWithin } from '../target/scope';
import type { BaseCheckInput, CheckInput } from './checkInput';
import { ourCheck, statusForCredit } from './ourCheck';
import { contentLinks, pageKey } from './pageContent';

/**
 * Whether crawlers may read the docs, and whether the sitemap covers them.
 *
 * The permissions check only counts fetchers whose published policy says
 * robots.txt governs them, so a disallow is evidence of a block. Fetchers
 * that say robots.txt may not apply to user-initiated requests are reported
 * but never scored, and so are training crawlers: opting out of training is
 * a policy choice, not a readiness problem.
 */

export const CRAWLER_POLICY = {
  /** When each provider's page was last read. Re-check before changing the lists. */
  checkedOn: '2026-09-24',
  honoursRobots: [
    { token: 'Googlebot', role: 'search', source: 'https://developers.google.com/search/docs/crawling-indexing/robots/intro' },
    { token: 'Bingbot', role: 'search', source: 'https://www.bing.com/webmasters/help/which-crawlers-does-bing-use-8c184ec0' },
    { token: 'OAI-SearchBot', role: 'search', source: 'https://developers.openai.com/api/docs/bots' },
    { token: 'PerplexityBot', role: 'search', source: 'https://docs.perplexity.ai/guides/bots' },
    {
      token: 'Claude-SearchBot',
      role: 'search',
      source: 'https://support.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler',
    },
    {
      token: 'Claude-User',
      role: 'assistant',
      source: 'https://support.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler',
    },
  ],
  /** User-initiated fetchers whose policy says robots.txt may not apply: a disallow proves nothing. */
  mayIgnoreRobots: ['ChatGPT-User', 'Perplexity-User'],
  training: ['GPTBot', 'ClaudeBot', 'Google-Extended', 'CCBot'],
} as const;

export async function checkCrawlerPermissions(input: BaseCheckInput): Promise<ReportCheck> {
  const scopeUrl = new URL(`${input.target.scopeRoot}/`);
  const file = await input.robots.fileFor(scopeUrl.origin);

  if (file.state === 'unreachable') {
    return ourCheck(
      'crawler-permissions',
      'unverified',
      null,
      `${scopeUrl.origin}/robots.txt could not be read (a server error or timeout), so crawler permissions could not be verified. Well-behaved crawlers treat that as a block.`,
      'Make sure robots.txt answers with 200 or 404. A server error or timeout on robots.txt tells crawlers to stay away entirely.',
    );
  }

  const blocked: string[] = [];
  for (const crawler of CRAWLER_POLICY.honoursRobots) {
    if ((await input.robots.allowsAgent(scopeUrl, crawler.token)) === false) blocked.push(crawler.token);
  }
  const notes = [
    await blockedNote(input, scopeUrl, CRAWLER_POLICY.mayIgnoreRobots, 'its provider says robots.txt may not apply to user requests, so this is reported, not scored'),
    await blockedNote(input, scopeUrl, CRAWLER_POLICY.training, 'training crawlers; opting out of training is a policy choice, not scored'),
  ]
    .filter(Boolean)
    .join(' ');
  const total = CRAWLER_POLICY.honoursRobots.length;
  const credit = (total - blocked.length) / total;
  const tokens = CRAWLER_POLICY.honoursRobots.map((crawler) => crawler.token);

  if (blocked.length === 0) {
    return ourCheck(
      'crawler-permissions',
      'pass',
      1,
      `robots.txt lets ${listOf(tokens)} read the docs.${notes ? ` ${notes}` : ''}`,
    );
  }
  return ourCheck(
    'crawler-permissions',
    statusForCredit(credit, { pass: 1, warn: 0.01 }),
    credit,
    `robots.txt blocks ${listOf(blocked)} from the docs (${blocked.length} of the ${total} crawlers that honour it).${notes ? ` ${notes}` : ''}`,
    `Allow ${listOf(blocked)} for the documentation paths in robots.txt. They fetch pages to index them or when a person asks about your product; blocking them hides the docs from those answers.`,
  );
}

async function blockedNote(
  input: BaseCheckInput,
  scopeUrl: URL,
  tokens: readonly string[],
  why: string,
): Promise<string> {
  const blocked: string[] = [];
  for (const token of tokens) {
    if ((await input.robots.allowsAgent(scopeUrl, token)) === false) blocked.push(token);
  }
  return blocked.length ? `Also blocked: ${listOf(blocked)} (${why}).` : '';
}

export async function checkSitemapCoverage(input: CheckInput): Promise<ReportCheck> {
  const discovered = discoveredPages(input);
  if (discovered.size === 0) {
    return ourCheck('sitemap-coverage', 'skip', null, 'No docs pages were found on their own to compare with the sitemap.');
  }

  const sitemap = await input.sitemap;
  if (!sitemap.url) {
    return ourCheck(
      'sitemap-coverage',
      'fail',
      0,
      `No sitemap was found for these docs, so none of the ${discovered.size} pages found through llms.txt and page links is listed in one.`,
      'Publish a sitemap.xml listing every documentation page and reference it from robots.txt with a Sitemap: line.',
    );
  }

  const listed = new Set(sitemap.inScope.map((entry) => pageKey(entry.loc)));
  const missing = [...discovered.entries()].filter(([key]) => !listed.has(key)).map(([, url]) => url);
  const covered = discovered.size - missing.length;
  const credit = covered / discovered.size;
  return ourCheck(
    'sitemap-coverage',
    statusForCredit(credit, { pass: 0.9, warn: 0.5 }),
    credit,
    `The sitemap at ${sitemap.url} lists ${covered} of the ${discovered.size} docs pages found through llms.txt and page links.`,
    missing.length
      ? 'Generate the sitemap from the same source as the docs, so every page is listed. Agents and crawlers use it to find pages that navigation does not link.'
      : undefined,
    missing.slice(0, 5),
  );
}

/** Docs pages the scan found without the sitemap: the sample, llms.txt links and links on the pages, keyed by document. */
function discoveredPages(input: CheckInput): Map<string, string> {
  const found = new Map<string, string>();
  const add = (url: string) => {
    if (!inScope(url, input.scopeRoot)) return;
    const key = pageKey(url);
    if (!found.has(key)) found.set(key, url);
  };
  for (const page of input.pages) add(page.url);
  for (const match of input.llmsTxt?.content.matchAll(/\((https?:\/\/[^)\s]+)\)/g) ?? []) add(match[1]);
  for (const page of input.pages) for (const link of contentLinks(page)) add(link);
  return found;
}

function inScope(link: string, root: URL): boolean {
  try {
    const url = new URL(link);
    if (/\.(png|jpe?g|gif|svg|webp|ico|pdf|zip|xml|json|txt|css|js)$/i.test(url.pathname)) return false;
    return (
      url.hostname.replace(/^www\./, '') === root.hostname.replace(/^www\./, '') &&
      isWithin(url.pathname, root.pathname)
    );
  } catch {
    return false;
  }
}

function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
