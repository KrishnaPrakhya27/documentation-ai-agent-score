import { generateText, Output } from 'ai';
import { z } from 'zod';

import { ANSWERABILITY_LIMITS } from '../methodology';
import { QUESTION_WRITER_SYSTEM } from './prompts';
import { containsQuote } from './sourcePages';
import type { AnswerabilityModels, GeneratedQuestion, ModelUsage, SourcePage } from './types';

/**
 * Writes realistic user questions from the sampled pages with the cheap
 * model, then keeps only those whose evidence quote really is on the page
 * they claim, so no question is unanswerable by construction.
 */

const questionSchema = z.object({
  questions: z
    .array(
      z.object({
        question: z.string(),
        sourceUrl: z.string(),
        answerFacts: z.array(z.string()),
        evidenceQuote: z.string(),
      }),
    )
    .max(12),
});

export async function generateQuestions(
  pages: SourcePage[],
  models: AnswerabilityModels,
  usage: ModelUsage[],
  abortSignal?: AbortSignal,
): Promise<GeneratedQuestion[]> {
  const prompt = [
    `Write ${ANSWERABILITY_LIMITS.maxQuestions + 2} questions from these ${pages.length} documentation pages.`,
    ...pages.map(
      (page, index) =>
        `\n--- Page ${index + 1}\nURL: ${page.url}\nTitle: ${page.title}\nText:\n${page.text.slice(0, ANSWERABILITY_LIMITS.maxCharsPerSourcePage)}`,
    ),
  ].join('\n');

  const result = await generateText({
    model: models.questions.model,
    system: QUESTION_WRITER_SYSTEM,
    prompt,
    output: Output.object({ schema: questionSchema }),
    maxOutputTokens: 4_000,
    temperature: 0,
    abortSignal,
  });
  usage.push({
    model: models.questions.id,
    inputTokens: result.usage.inputTokens ?? 0,
    outputTokens: result.usage.outputTokens ?? 0,
  });

  return selectValidQuestions(result.output?.questions ?? [], pages);
}

/** Keeps grounded, distinct questions, at most two per page, in the model's order. */
export function selectValidQuestions(
  candidates: GeneratedQuestion[],
  pages: SourcePage[],
): GeneratedQuestion[] {
  const byUrl = new Map(pages.map((page) => [page.url, page]));
  const perPage = new Map<string, number>();
  const seen = new Set<string>();
  const kept: GeneratedQuestion[] = [];

  for (const candidate of candidates) {
    const page = byUrl.get(candidate.sourceUrl);
    const key = candidate.question.trim().toLowerCase();
    if (!page || seen.has(key) || candidate.answerFacts.length === 0) continue;
    if (!containsQuote(page.text, candidate.evidenceQuote)) continue;
    if ((perPage.get(page.url) ?? 0) >= 2) continue;

    seen.add(key);
    perPage.set(page.url, (perPage.get(page.url) ?? 0) + 1);
    kept.push({
      question: candidate.question.trim().slice(0, 300),
      sourceUrl: page.url,
      answerFacts: candidate.answerFacts.slice(0, 4).map((fact) => fact.slice(0, 300)),
      evidenceQuote: candidate.evidenceQuote.slice(0, 400),
    });
    if (kept.length === ANSWERABILITY_LIMITS.maxQuestions) break;
  }
  return kept;
}
