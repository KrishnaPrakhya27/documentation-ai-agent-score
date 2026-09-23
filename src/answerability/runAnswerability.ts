import { createScanFetcher } from '../assess';
import {
  ANSWERABILITY_LIMITS,
  FALLBACK_MODEL_PRICE,
  MODEL_PRICES,
} from '../methodology';
import type { AnswerabilityResult, TranscriptEntry } from '../report.types';
import { diagnose, type FailureCause } from './diagnose';
import { generateQuestions } from './generateQuestions';
import { judgeAnswer } from './judgeAnswer';
import { solveQuestion } from './solveQuestion';
import { loadSourcePages } from './sourcePages';
import type {
  AnswerabilityDeps,
  AnswerabilityInput,
  AnswerabilityRun,
  GeneratedQuestion,
  ModelUsage,
  SolveOutcome,
} from './types';

/**
 * The slow half of a scan: writes questions from the sampled pages, lets an
 * agent answer each through the guarded transport, grades the answers and
 * explains every miss. Operational failures are excluded rather than scored;
 * fewer than five gradable questions leaves the pillar unavailable.
 */

export async function runAnswerability(
  input: AnswerabilityInput,
  deps: AnswerabilityDeps,
): Promise<AnswerabilityRun> {
  const now = deps.now ?? Date.now;
  const fetcher = createScanFetcher(now() + ANSWERABILITY_LIMITS.deadlineMs, {
    maxRequests: ANSWERABILITY_LIMITS.requestBudget,
    ...deps.fetcher,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ANSWERABILITY_LIMITS.deadlineMs);
  const usage: ModelUsage[] = [];
  const models = {
    questions: deps.models.questions.id,
    solver: deps.models.solver.id,
    judge: deps.models.judge.id,
  };
  const unavailable = (reason: string): AnswerabilityResult => ({
    state: 'unavailable',
    score: null,
    passed: 0,
    total: 0,
    transcript: [],
    reason,
    models,
  });

  try {
    const pages = await loadSourcePages(fetcher, input.sampledUrls, deps.renderer);
    if (pages.length < 2) {
      return finish(unavailable('Too few readable pages to write questions from.'), usage);
    }

    const questions = await generateQuestions(pages, deps.models, usage, controller.signal);
    if (questions.length < ANSWERABILITY_LIMITS.minQuestions) {
      return finish(
        unavailable('Not enough answerable questions could be written from the sampled pages.'),
        usage,
      );
    }

    const outcomes = await mapLimited(
      questions,
      ANSWERABILITY_LIMITS.solveConcurrency,
      async (question): Promise<SolveOutcome> => {
        if (inputTokens(usage) > ANSWERABILITY_LIMITS.maxInputTokensPerRun) {
          return { answer: '', fetches: [], operationalError: 'token budget reached' };
        }
        const perQuestion = AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(ANSWERABILITY_LIMITS.solveTimeoutMs),
        ]);
        return solveQuestion(question, {
          http: fetcher,
          target: input.target,
          models: deps.models,
          usage,
          abortSignal: perQuestion,
        });
      },
    );

    const transcript: TranscriptEntry[] = [];
    const causes: FailureCause[] = [];
    await Promise.all(
      questions.map(async (question, index) => {
        const outcome = outcomes[index];
        if (outcome.operationalError) return;
        const judgement = await judgeAnswer(
          question,
          outcome.answer,
          deps.models,
          usage,
          controller.signal,
        );
        if (!judgement) return;
        const source = pages.find((page) => page.url === question.sourceUrl);
        const diagnosis = diagnose(question, source, outcome, judgement.verdict, judgement.reason);
        if (diagnosis.cause) causes.push(diagnosis.cause);
        transcript[index] = entryFor(question, outcome, judgement.verdict, diagnosis.reason);
      }),
    );

    const graded = transcript.filter(Boolean);
    if (graded.length < ANSWERABILITY_LIMITS.minQuestions) {
      return finish(
        unavailable('Too few questions could be tested to give a fair score.'),
        usage,
      );
    }
    const passed = graded.filter((entry) => entry.verdict === 'correct').length;
    return finish(
      {
        state: 'complete',
        score: Math.round((passed / graded.length) * 100),
        passed,
        total: graded.length,
        transcript: graded,
        models,
      },
      usage,
    );
  } catch (error) {
    const aborted = controller.signal.aborted;
    return finish(
      unavailable(
        aborted
          ? 'Answerability ran out of time before enough questions were tested.'
          : 'Answerability could not run for this scan.',
      ),
      usage,
    );
  } finally {
    clearTimeout(timer);
    await fetcher.close();
  }
}

function entryFor(
  question: GeneratedQuestion,
  outcome: SolveOutcome,
  verdict: TranscriptEntry['verdict'],
  reason: string,
): TranscriptEntry {
  return {
    question: question.question,
    sourceUrl: question.sourceUrl,
    answer: outcome.answer.slice(0, 1_200),
    verdict,
    reason,
    pagesVisited: outcome.fetches.map((fetch) => fetch.url).slice(0, 6),
  };
}

function finish(result: AnswerabilityResult, usage: ModelUsage[]): AnswerabilityRun {
  return { result, usage, costUsd: estimateCostUsd(usage) };
}

export function estimateCostUsd(usage: ModelUsage[]): number {
  const total = usage.reduce((sum, entry) => {
    const price = MODEL_PRICES[entry.model] ?? FALLBACK_MODEL_PRICE;
    return sum + (entry.inputTokens * price.input + entry.outputTokens * price.output) / 1_000_000;
  }, 0);
  return Math.round(total * 10_000) / 10_000;
}

function inputTokens(usage: ModelUsage[]): number {
  return usage.reduce((sum, entry) => sum + entry.inputTokens, 0);
}

/** Maps with at most `limit` calls in flight, keeping the input order. */
async function mapLimited<T, R>(
  items: T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}
