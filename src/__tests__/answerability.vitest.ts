import type { LanguageModelV3Prompt } from '@ai-sdk/provider';
import { MockLanguageModelV3 } from 'ai/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { diagnose, samePage } from '../answerability/diagnose';
import { selectValidQuestions } from '../answerability/generateQuestions';
import { estimateCostUsd, runAnswerability } from '../answerability/runAnswerability';
import { containsQuote } from '../answerability/sourcePages';
import type {
  AnswerabilityModels,
  GeneratedQuestion,
  SolveOutcome,
  SourcePage,
} from '../answerability/types';
import { finalizeReport } from '../finalize';
import type { AgentScoreReport, AnswerabilityResult } from '../report.types';
import {
  allowOnly,
  startFixtureSite,
  type FixtureRoute,
  type FixtureSite,
} from './fixtureServer';

/**
 * Answerability end to end with scripted models against a local site: the
 * solver really fetches pages through the guarded transport, the judge
 * grades, and each miss is explained by what the agent actually read.
 */

const SLUGS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'];
const QUOTE = 'To create an API key, open Settings and choose API keys, then press Create key';

const usage = {
  inputTokens: { total: 1_000, noCache: 1_000, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 100, text: 100, reasoning: 0 },
};
const stop = { unified: 'stop' as const, raw: 'stop' };

function textModel(respond: (prompt: LanguageModelV3Prompt) => string) {
  return new MockLanguageModelV3({
    doGenerate: async (options) => ({
      content: [{ type: 'text', text: respond(options.prompt) }],
      finishReason: stop,
      usage,
      warnings: [],
    }),
  });
}

function lastUserText(prompt: LanguageModelV3Prompt): string {
  const user = [...prompt].reverse().find((message) => message.role === 'user');
  if (!user || typeof user.content === 'string') return '';
  return user.content.map((part) => ('text' in part ? part.text : '')).join('');
}

const routes: Record<string, FixtureRoute> = {};
let site: FixtureSite;

beforeAll(async () => {
  site = await startFixtureSite(routes);
  const filler = 'Acme keeps every workspace isolated and audited. '.repeat(12);
  for (const slug of SLUGS) {
    routes[`/docs/${slug}`] = {
      body: `<html><head><title>${slug} | Acme</title></head><body><main><h1>${slug}</h1><p>${filler}</p><p>${QUOTE}.</p></main></body></html>`,
    };
  }
  routes['/docs'] = {
    body: `<html><body><main>${SLUGS.map((slug) => `<a href="/docs/${slug}">${slug}</a>`).join(' ')}</main></body></html>`,
  };
});

afterAll(async () => {
  await site.close();
});

function models(): AnswerabilityModels {
  const questions = textModel(() =>
    JSON.stringify({
      questions: SLUGS.map((slug) => ({
        question: `How do I create an API key in ${slug}?`,
        sourceUrl: `${site.origin}/docs/${slug}`,
        answerFacts: ['Open Settings', 'Choose API keys'],
        evidenceQuote: QUOTE,
      })),
    }),
  );

  // Fetches the page the question names, then answers from what came back;
  // for "echo" it gives up without fetching.
  const solver = new MockLanguageModelV3({
    doGenerate: async (options) => {
      const question = lastUserText(options.prompt);
      const slug = SLUGS.find((name) => question.includes(name)) ?? 'alpha';
      const lastMessage = options.prompt[options.prompt.length - 1];
      if (slug === 'echo') {
        return {
          content: [{ type: 'text', text: 'NOT FOUND: nothing about keys.' }],
          finishReason: stop,
          usage,
          warnings: [],
        };
      }
      if (lastMessage.role !== 'tool') {
        return {
          content: [
            {
              type: 'tool-call',
              toolCallId: `call-${slug}`,
              toolName: 'fetch_page',
              input: JSON.stringify({ url: `${site.origin}/docs/${slug}` }),
            },
          ],
          finishReason: { unified: 'tool-calls', raw: 'tool_use' },
          usage,
          warnings: [],
        };
      }
      const toolOutput = JSON.stringify(lastMessage.content);
      return {
        content: [
          {
            type: 'text',
            text: toolOutput.includes('open Settings')
              ? 'Open Settings, choose API keys, then press Create key.'
              : 'I am not sure.',
          },
        ],
        finishReason: stop,
        usage,
        warnings: [],
      };
    },
  });

  const judge = textModel((prompt) => {
    const text = lastUserText(prompt);
    const answer = text.split('"""')[1] ?? '';
    return JSON.stringify(
      answer.includes('Open Settings')
        ? { verdict: 'correct', reason: 'It names the right steps.' }
        : { verdict: 'incorrect', reason: 'It does not give the steps.' },
    );
  });

  return {
    questions: { id: 'anthropic/claude-haiku-4.5', model: questions },
    solver: { id: 'anthropic/claude-haiku-4.5', model: solver },
    judge: { id: 'anthropic/claude-sonnet-5', model: judge },
  };
}

function target() {
  return {
    submittedUrl: `${site.origin}/docs`,
    resolvedUrl: `${site.origin}/docs`,
    scopeRoot: `${site.origin}/docs`,
    key: '127.0.0.1/docs',
    domain: '127.0.0.1',
    profile: 'developer-docs' as const,
    locale: null,
    version: null,
  };
}

describe('runAnswerability', () => {
  it('scores graded answers and explains the miss', async () => {
    const run = await runAnswerability(
      { target: target(), sampledUrls: SLUGS.map((slug) => `${site.origin}/docs/${slug}`) },
      {
        models: models(),
        fetcher: { validateUrl: allowOnly(site.origin), isAllowedAddress: () => true, minIntervalMs: 0 },
      },
    );

    const result = run.result;
    expect(result.state).toBe('complete');
    expect(result.total).toBe(6);
    expect(result.passed).toBe(5);
    expect(result.score).toBe(83);

    const miss = result.transcript.find((entry) => entry.verdict !== 'correct');
    expect(miss?.verdict).toBe('not-found');
    expect(miss?.reason).toMatch(/never reached \/docs\/echo/);

    const hit = result.transcript.find((entry) => entry.question.includes('alpha'));
    expect(hit?.reason).toBe('Answered correctly from /docs/alpha.');
    expect(hit?.pagesVisited).toEqual([`${site.origin}/docs/alpha`]);
    expect(run.costUsd).toBeGreaterThan(0);
  });

  it('is unavailable, not zero, when too few questions can be written', async () => {
    const run = await runAnswerability(
      { target: target(), sampledUrls: [`${site.origin}/docs/alpha`] },
      {
        models: models(),
        fetcher: { validateUrl: allowOnly(site.origin), isAllowedAddress: () => true, minIntervalMs: 0 },
      },
    );
    expect(run.result.state).toBe('unavailable');
    expect(run.result.score).toBeNull();
  });
});

describe('selectValidQuestions', () => {
  const pages: SourcePage[] = [
    { url: 'https://d.test/a', title: 'A', text: `Intro. ${QUOTE}. More.`, needsJavaScript: false },
    { url: 'https://d.test/b', title: 'B', text: 'Nothing relevant here at all.', needsJavaScript: false },
  ];
  const question = (overrides: Partial<GeneratedQuestion>): GeneratedQuestion => ({
    question: 'How do I create a key?',
    sourceUrl: 'https://d.test/a',
    answerFacts: ['Open Settings'],
    evidenceQuote: QUOTE,
    ...overrides,
  });

  it('keeps grounded questions and drops invented quotes, unknown pages and repeats', () => {
    const kept = selectValidQuestions(
      [
        question({}),
        question({ question: 'How do I create a key?' }),
        question({ question: 'Where is billing?', sourceUrl: 'https://d.test/b' }),
        question({ question: 'Other?', sourceUrl: 'https://elsewhere.test/x' }),
        question({ question: 'Second on A?' }),
        question({ question: 'Third on A?' }),
      ],
      pages,
    );
    expect(kept.map((entry) => entry.question)).toEqual(['How do I create a key?', 'Second on A?']);
  });
});

describe('diagnose', () => {
  const question: GeneratedQuestion = {
    question: 'How do I create a key?',
    sourceUrl: 'https://d.test/docs/keys',
    answerFacts: ['Open Settings'],
    evidenceQuote: QUOTE,
  };
  const outcome = (fetches: SolveOutcome['fetches']): SolveOutcome => ({ answer: 'x', fetches });
  const read = (agentText: string, extra: Partial<SolveOutcome['fetches'][number]> = {}) => ({
    url: 'https://d.test/docs/keys.md',
    status: 200,
    agentText,
    truncated: false,
    fullLength: agentText.length,
    ...extra,
  });

  it('says when the answer was cut off by the length limit', () => {
    const result = diagnose(question, undefined, outcome([read('intro only', { truncated: true, fullLength: 250_000 })]), 'not-found', '');
    expect(result.cause).toBe('truncated');
  });

  it('blames JavaScript only when a rendered copy proved it', () => {
    const rendered: SourcePage = { url: question.sourceUrl, title: 'Keys', text: QUOTE, needsJavaScript: true };
    expect(diagnose(question, rendered, outcome([read('shell')]), 'not-found', '').cause).toBe('javascript');
    const raw: SourcePage = { ...rendered, needsJavaScript: false };
    expect(diagnose(question, raw, outcome([read('shell')]), 'not-found', '').cause).toBe('not-in-text');
  });

  it('separates misreading a page from never reaching it', () => {
    expect(diagnose(question, undefined, outcome([read(QUOTE)]), 'incorrect', 'Wrong steps.').reason).toMatch(/answered incorrectly: Wrong steps\./);
    expect(diagnose(question, undefined, outcome([]), 'not-found', '').cause).toBe('not-reached');
  });

  it('treats the .md twin and a trailing slash as the same page', () => {
    expect(samePage('https://d.test/docs/keys.md', 'https://d.test/docs/keys/')).toBe(true);
    expect(samePage('https://d.test/docs/keys', 'https://d.test/docs/keys-old')).toBe(false);
  });
});

describe('containsQuote', () => {
  it('tolerates punctuation and small wording drift but not a different sentence', () => {
    expect(containsQuote(`**To create** an API key, open _Settings_ and choose API keys, then press "Create key".`, QUOTE)).toBe(true);
    expect(containsQuote('Delete a project from the dashboard menu.', QUOTE)).toBe(false);
  });
});

describe('finalizeReport', () => {
  it('computes the composite and leads with the answerability fix', () => {
    const technical = {
      stage: 'technical',
      target: { scopeRoot: 'https://d.test/docs', key: 'd.test/docs' },
      checks: [],
      site: { name: 'D', title: null },
      topFixes: [{ checkId: 'x', title: 'X', fix: 'Do x.' }],
      limitations: [],
      timings: { startedAt: '2026-09-23T00:00:00Z' },
      pillars: {
        access: { state: 'complete', score: 80, profile: 'developer-docs', afdocs: null },
        freshness: { state: 'complete', score: 70, components: [] },
        answerability: { state: 'pending', score: null, passed: 0, total: 0, transcript: [] },
      },
    } as unknown as AgentScoreReport;
    const answerability: AnswerabilityResult = {
      state: 'complete',
      score: 50,
      passed: 3,
      total: 6,
      transcript: Array.from({ length: 3 }, (_, index) => ({
        question: `q${index}`,
        sourceUrl: 'https://d.test/docs/a',
        answer: '',
        verdict: 'not-found' as const,
        reason: 'The agent never reached /docs/a, the page with the answer.',
        pagesVisited: [],
      })),
    };

    const report = finalizeReport(technical, answerability, 'https://documentation.ai/agent-score/d.test/docs');
    expect(report.stage).toBe('final');
    expect(report.overall).toEqual({ score: 66, grade: 'D' });
    expect(report.topFixes[0].checkId).toBe('answerability');
    expect(report.fixPrompt).toContain('Questions an agent could not answer');
  });
});

describe('estimateCostUsd', () => {
  it('prices known models and falls back conservatively', () => {
    expect(estimateCostUsd([{ model: 'anthropic/claude-haiku-4.5', inputTokens: 1_000_000, outputTokens: 0 }])).toBe(1);
    expect(estimateCostUsd([{ model: 'unknown/model', inputTokens: 1_000_000, outputTokens: 0 }])).toBe(5);
  });
});

describe('createAnswerabilityModels', () => {
  it('builds the default models for a provider without calling it', async () => {
    const { createAnswerabilityModels } = await import('../answerability/providers');
    const chosen = await createAnswerabilityModels({ provider: 'anthropic', apiKey: 'sk-test' });
    expect(chosen.questions.id).toBe('anthropic/claude-haiku-4-5-20251001');
    expect(chosen.judge.id).toBe('anthropic/claude-sonnet-5');
  });

  it('refuses a missing key and a model outside the allowed list', async () => {
    const { AiConfigError, createAnswerabilityModels } = await import('../answerability/providers');
    await expect(createAnswerabilityModels({ provider: 'openai', apiKey: '' })).rejects.toBeInstanceOf(
      AiConfigError,
    );
    await expect(
      createAnswerabilityModels({ provider: 'google', apiKey: 'k', models: { judge: 'gpt-5.4' } }),
    ).rejects.toThrow(/not an allowed Google Gemini model/);
  });
});
