import type { ReportCheck } from '../report.types';
import type { BaseCheckInput, CheckInput } from './checkInput';

/**
 * Whether robots.txt lets AI agents read the docs, and whether a sitemap
 * lists them. Blocking the agents that fetch on a person's behalf stops them
 * reading the docs at all; blocking training crawlers is reported separately
 * as a policy choice.
 */

export const USER_AGENTS_ON_BEHALF_OF_PEOPLE = [
  'ChatGPT-User',
  'OAI-SearchBot',
  'Claude-User',
  'Claude-SearchBot',
  'Perplexity-User',
  'PerplexityBot',
];

export const TRAINING_CRAWLERS = ['GPTBot', 'ClaudeBot', 'Google-Extended', 'CCBot'];

export async function checkRobotsAiAccess(input: BaseCheckInput): Promise<ReportCheck> {
  const scopeUrl = new URL(`${input.target.scopeRoot}/`);
  const file = await input.robots.fileFor(scopeUrl.origin);

  if (file.state === 'unreachable') {
    return crawlerCheck(
      'robots-ai-access',
      'warn',
      `${scopeUrl.origin}/robots.txt could not be read, so crawlers must treat the whole site as off limits.`,
      'Make sure robots.txt answers with 200 or 404. A server error or timeout on robots.txt tells well-behaved crawlers to stay away entirely.',
    );
  }

  const blocked: string[] = [];
  for (const agent of USER_AGENTS_ON_BEHALF_OF_PEOPLE) {
    if ((await input.robots.allowsAgent(scopeUrl, agent)) === false) blocked.push(agent);
  }
  const blockedTraining: string[] = [];
  for (const agent of TRAINING_CRAWLERS) {
    if ((await input.robots.allowsAgent(scopeUrl, agent)) === false) blockedTraining.push(agent);
  }
  const trainingNote = blockedTraining.length
    ? ` Training crawlers blocked: ${blockedTraining.join(', ')} (a policy choice, not scored).`
    : '';

  if (blocked.length === 0) {
    return crawlerCheck(
      'robots-ai-access',
      'pass',
      `robots.txt lets AI assistants that fetch on a person's behalf read the docs.${trainingNote}`,
    );
  }
  return crawlerCheck(
    'robots-ai-access',
    blocked.length === USER_AGENTS_ON_BEHALF_OF_PEOPLE.length ? 'fail' : 'warn',
    `robots.txt blocks ${blocked.join(', ')} from the docs.${trainingNote}`,
    `Allow ${blocked.join(', ')} in robots.txt. These agents only fetch a page when a person asks about your product, so blocking them hides your docs from those answers.`,
  );
}

export async function checkSitemap(input: CheckInput): Promise<ReportCheck> {
  const sitemap = await input.sitemap;
  if (sitemap.inScope.length > 0) {
    const count = sitemap.inScope.length;
    return crawlerCheck(
      'sitemap',
      'pass',
      `The sitemap at ${sitemap.url} lists ${count}${count >= 5_000 ? '+' : ''} page${count === 1 ? '' : 's'} inside ${input.target.key}.`,
    );
  }
  if (input.discoverySources.includes('sitemap')) {
    return crawlerCheck('sitemap', 'pass', 'A sitemap lists the documentation pages.');
  }
  if (sitemap.url) {
    return crawlerCheck(
      'sitemap',
      'warn',
      `A sitemap exists at ${sitemap.url}, but none of the entries read lie inside ${input.target.key}.`,
      'Include every documentation page in your sitemap so agents and crawlers can find pages that are not linked from navigation.',
    );
  }
  return crawlerCheck(
    'sitemap',
    'fail',
    'No sitemap was found for these docs.',
    'Publish a sitemap.xml listing every documentation page and reference it from robots.txt with a Sitemap: line.',
  );
}

const TITLES: Record<string, string> = {
  'robots-ai-access': 'robots.txt lets AI agents in',
  sitemap: 'Sitemap lists the docs',
};

function crawlerCheck(
  id: string,
  status: 'pass' | 'warn' | 'fail',
  message: string,
  fix?: string,
): ReportCheck {
  return {
    id,
    pillar: 'access',
    group: 'crawler-access',
    title: TITLES[id],
    status,
    scored: false,
    source: 'agent-score',
    message,
    ...(fix && { fix }),
  };
}
