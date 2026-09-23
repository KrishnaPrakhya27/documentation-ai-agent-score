import type { AnswerVerdict } from '../report.types';
import { containsQuote } from './sourcePages';
import type { GeneratedQuestion, SolveOutcome, SourcePage } from './types';

/**
 * Explains a verdict from what the agent actually fetched, so a failure says
 * whether the page was never found, cut off, hidden behind JavaScript, or
 * read and misunderstood. Claims about JavaScript are only made when a
 * rendered copy of the page proved it.
 */

export type FailureCause = 'not-reached' | 'error-status' | 'truncated' | 'javascript' | 'not-in-text' | 'misread';

export interface Diagnosis {
  reason: string;
  cause: FailureCause | null;
}

export function diagnose(
  question: GeneratedQuestion,
  source: SourcePage | undefined,
  outcome: SolveOutcome,
  verdict: AnswerVerdict,
  judgeReason: string,
): Diagnosis {
  const sourcePath = shortPath(question.sourceUrl);
  if (verdict === 'correct') {
    return { reason: `Answered correctly from ${sourcePath}.`, cause: null };
  }

  const read = outcome.fetches.find((fetch) => samePage(fetch.url, question.sourceUrl));
  if (!read) {
    const visited = outcome.fetches.map((fetch) => shortPath(fetch.url)).slice(0, 4);
    return {
      cause: 'not-reached',
      reason: `The agent never reached ${sourcePath}, the page with the answer.${
        visited.length ? ` It read ${visited.join(', ')}.` : ' It could not find a way in.'
      }`,
    };
  }
  if (read.status === null || read.status >= 400) {
    return {
      cause: 'error-status',
      reason: `${sourcePath} ${read.status ? `returned ${read.status}` : 'could not be fetched'} when the agent requested it.`,
    };
  }

  if (!containsQuote(read.agentText, question.evidenceQuote)) {
    if (read.truncated) {
      return {
        cause: 'truncated',
        reason: `The answer is on ${sourcePath}, but the page is ${read.fullLength.toLocaleString('en-US')} characters long and the agent only reads the first ${read.agentText.length.toLocaleString('en-US')}, so the answer was cut off.`,
      };
    }
    if (source?.needsJavaScript) {
      return {
        cause: 'javascript',
        reason: `The answer on ${sourcePath} only appears after JavaScript runs, and the agent reads pages without JavaScript.`,
      };
    }
    return {
      cause: 'not-in-text',
      reason: `The agent read ${sourcePath}, but the answer was not in the text it received, for example inside a tab or widget that is not in the HTML.`,
    };
  }

  return {
    cause: 'misread',
    reason:
      verdict === 'not-found'
        ? `The agent read ${sourcePath}, where the answer is, but did not recognise it. The answer may be buried or worded differently from the question.`
        : `The agent read ${sourcePath} but answered incorrectly: ${judgeReason}`,
  };
}

/** Same document, ignoring a trailing slash, a .md twin, query and fragment. */
export function samePage(a: string, b: string): boolean {
  return canonical(a) === canonical(b);
}

function canonical(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/index\.mdx?$/, '').replace(/\.mdx?$/, '').replace(/\/+$/, '');
    return `${parsed.hostname.replace(/^www\./, '')}${path}`;
  } catch {
    return url;
  }
}

function shortPath(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname === '/' ? parsed.hostname : parsed.pathname;
  } catch {
    return url;
  }
}
