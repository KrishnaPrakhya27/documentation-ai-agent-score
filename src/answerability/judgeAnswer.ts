import { generateText, Output } from 'ai';
import { z } from 'zod';

import type { AnswerVerdict } from '../report.types';
import { samePage } from './diagnose';
import { JUDGE_SYSTEM, judgePrompt } from './prompts';
import type { AnswerabilityModels, GeneratedQuestion, ModelUsage, SolveOutcome } from './types';

/**
 * Grades an agent's answer against the reference facts in a separate call,
 * so the solver never sees them, and checks whether the answer's claims are
 * backed by the passages it cited. A missing answer is decided without a
 * model call; one failed grading is retried once before it is dropped.
 */

const verdictSchema = z.object({
  verdict: z.enum(['correct', 'incorrect', 'not-found']),
  reason: z.string(),
  supported: z.boolean().nullable().optional(),
});

/** How much of each cited page the judge sees; enough to find a claim, not the whole page. */
const PASSAGE_CHARS = 2_500;
const MAX_PASSAGES = 3;

export interface Judgement {
  verdict: AnswerVerdict;
  reason: string;
  /** Null for an answer that made no claims (not found). */
  supported: boolean | null;
}

export async function judgeAnswer(
  question: GeneratedQuestion,
  outcome: SolveOutcome,
  models: AnswerabilityModels,
  usage: ModelUsage[],
  abortSignal?: AbortSignal,
): Promise<Judgement | null> {
  const answer = outcome.answer;
  if (!answer || /^not found\b/i.test(answer)) {
    return { verdict: 'not-found', reason: 'The agent said it could not find the answer.', supported: null };
  }
  const citedPassages = citedPassagesOf(outcome);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await generateText({
        model: models.judge.model,
        system: JUDGE_SYSTEM,
        prompt: judgePrompt({ ...question, answer, citedPassages }),
        output: Output.object({ schema: verdictSchema }),
        maxOutputTokens: 300,
        temperature: 0,
        abortSignal,
      });
      usage.push({
        model: models.judge.id,
        inputTokens: result.usage.inputTokens ?? 0,
        outputTokens: result.usage.outputTokens ?? 0,
      });
      if (result.output) {
        const verdict = result.output.verdict;
        return {
          verdict,
          reason: result.output.reason.trim().slice(0, 300),
          // No citation means no passage can back the claims, whatever the judge says.
          supported: verdict === 'not-found' ? null : citedPassages.length > 0 && result.output.supported === true,
        };
      }
    } catch {
      // Retried once; a second failure leaves the question ungraded.
    }
  }
  return null;
}

/** What the agent actually read on the pages it cited, for the support judgement. */
function citedPassagesOf(outcome: SolveOutcome): Array<{ url: string; text: string }> {
  const passages: Array<{ url: string; text: string }> = [];
  for (const cited of outcome.citedUrls) {
    const read = outcome.fetches.find((fetch) => samePage(fetch.url, cited) && fetch.agentText);
    if (!read || passages.some((passage) => passage.url === read.url)) continue;
    passages.push({ url: read.url, text: read.agentText.slice(0, PASSAGE_CHARS) });
    if (passages.length === MAX_PASSAGES) break;
  }
  return passages;
}
