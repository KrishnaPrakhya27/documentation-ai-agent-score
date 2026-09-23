import { generateText, stepCountIs, tool } from 'ai';
import { z } from 'zod';

import { ANSWERABILITY_LIMITS } from '../methodology';
import { classifyFetchError } from '../transport/errors';
import type { ScanHttpClient } from '../transport/guardedFetch';
import type { ReportTarget } from '../report.types';
import { baseDomain } from '../target/scope';
import { htmlToMarkdown, looksLikeHtml } from './pageText';
import { solverSystemPrompt } from './prompts';
import type {
  AnswerabilityModels,
  FetchRecord,
  GeneratedQuestion,
  ModelUsage,
  SolveOutcome,
} from './types';

/**
 * One question, answered the way an agent would: it starts at the docs entry
 * page with nothing but a fetch tool that returns what a non-JavaScript
 * client receives, converted to Markdown and cut at the agent's limit. It
 * never sees the question's source page or reference answer.
 */

const AGENT_ACCEPT = 'text/markdown, text/html;q=0.9, */*;q=0.5';

export async function solveQuestion(
  question: GeneratedQuestion,
  context: {
    http: ScanHttpClient;
    target: ReportTarget;
    models: AnswerabilityModels;
    usage: ModelUsage[];
    abortSignal?: AbortSignal;
  },
): Promise<SolveOutcome> {
  const { target } = context;
  const fetches: FetchRecord[] = [];
  const siteBase = baseDomain(target.domain);
  const maxFetches = ANSWERABILITY_LIMITS.maxFetchesPerQuestion;

  const fetchPage = tool({
    description:
      'Fetch a page from the documentation site. Returns the text an AI agent receives without running JavaScript.',
    inputSchema: z.object({
      url: z.string().describe('Absolute URL of a page on the documentation site'),
    }),
    execute: async ({ url }) => {
      if (fetches.length >= maxFetches) {
        return 'Fetch limit reached. Answer with what you have read.';
      }
      let requested: URL;
      try {
        requested = new URL(url, `${target.scopeRoot}/`);
      } catch {
        return 'That is not a valid URL.';
      }
      if (baseDomain(requested.hostname) !== siteBase) {
        return 'Refused: that URL is outside the documentation site.';
      }

      try {
        const response = await context.http.fetch(requested.href, {
          headers: { accept: AGENT_ACCEPT },
        });
        const body = await response.text();
        const type = response.headers.get('content-type') ?? '';
        const isHtml = type.includes('html') || (!type.includes('markdown') && looksLikeHtml(body));
        const text = isHtml ? htmlToMarkdown(body) : body;
        const limit = ANSWERABILITY_LIMITS.maxCharsPerFetch;
        const record: FetchRecord = {
          url: response.url,
          status: response.status,
          agentText: text.slice(0, limit),
          truncated: text.length > limit,
          fullLength: text.length,
        };
        fetches.push(record);
        const note = record.truncated
          ? ` (truncated: showing the first ${limit.toLocaleString('en-US')} of ${text.length.toLocaleString('en-US')} characters)`
          : '';
        return `HTTP ${response.status}${note}\nURL: ${response.url}\n\n${record.agentText}`;
      } catch (error) {
        fetches.push({
          url: requested.href,
          status: null,
          agentText: '',
          truncated: false,
          fullLength: 0,
        });
        return `Could not fetch the page (${classifyFetchError(error)}).`;
      }
    },
  });

  try {
    const result = await generateText({
      model: context.models.solver.model,
      system: solverSystemPrompt({
        scopeRoot: target.scopeRoot,
        entryUrl: target.resolvedUrl,
        origin: new URL(target.scopeRoot).origin,
        maxFetches,
      }),
      prompt: question.question,
      tools: { fetch_page: fetchPage },
      stopWhen: stepCountIs(maxFetches + 2),
      maxOutputTokens: 800,
      temperature: 0,
      abortSignal: context.abortSignal,
    });
    context.usage.push({
      model: context.models.solver.id,
      inputTokens: result.totalUsage.inputTokens ?? 0,
      outputTokens: result.totalUsage.outputTokens ?? 0,
    });
    return { answer: result.text.trim(), fetches };
  } catch (error) {
    return {
      answer: '',
      fetches,
      operationalError: error instanceof Error ? error.message.slice(0, 200) : 'solver failed',
    };
  }
}
