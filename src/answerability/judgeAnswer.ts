import { generateText, Output } from 'ai';
import { z } from 'zod';

import type { AnswerVerdict } from '../report.types';
import { JUDGE_SYSTEM, judgePrompt } from './prompts';
import type { AnswerabilityModels, GeneratedQuestion, ModelUsage } from './types';

/**
 * Grades an agent's answer against the reference facts in a separate call,
 * so the solver never sees them. A missing answer is decided without a
 * model call; one failed grading is retried once before it is dropped.
 */

const verdictSchema = z.object({
  verdict: z.enum(['correct', 'incorrect', 'not-found']),
  reason: z.string(),
});

export interface Judgement {
  verdict: AnswerVerdict;
  reason: string;
}

export async function judgeAnswer(
  question: GeneratedQuestion,
  answer: string,
  models: AnswerabilityModels,
  usage: ModelUsage[],
  abortSignal?: AbortSignal,
): Promise<Judgement | null> {
  if (!answer || /^not found\b/i.test(answer)) {
    return { verdict: 'not-found', reason: 'The agent said it could not find the answer.' };
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await generateText({
        model: models.judge.model,
        system: JUDGE_SYSTEM,
        prompt: judgePrompt({ ...question, answer }),
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
        return {
          verdict: result.output.verdict,
          reason: result.output.reason.trim().slice(0, 300),
        };
      }
    } catch {
      // Retried once; a second failure leaves the question ungraded.
    }
  }
  return null;
}
