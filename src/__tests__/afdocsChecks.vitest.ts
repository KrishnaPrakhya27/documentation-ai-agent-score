import { describe, expect, it } from 'vitest';

import { afdocsCap, summarizeAfdocs } from '../afdocs/afdocsChecks';
import type { AfdocsRun } from '../afdocs/runAfdocs';

/**
 * AFDocs' caps are recomputed from its results, because AFDocs only reports a
 * cap when its own score is above it, while the combined score can climb past
 * a cap that AFDocs' score sat under.
 */

function run(input: {
  results?: Array<{ id: string; status: string }>;
  checkScores?: Record<string, { proportion: number; scoreDisplayMode: 'numeric' | 'notApplicable'; earnedScore?: number; maxScore?: number }>;
  diagnostics?: string[];
  cap?: { cap: number; checkId: string; reason: string };
}): AfdocsRun {
  return {
    report: {
      results: input.results ?? [],
      summary: { pass: 1, total: 2 },
    },
    score: {
      overall: 50,
      grade: 'F',
      checkScores: Object.fromEntries(
        Object.entries(input.checkScores ?? {}).map(([id, score]) => [
          id,
          { earnedScore: 5, maxScore: 10, ...score },
        ]),
      ),
      resolutions: {},
      diagnostics: (input.diagnostics ?? []).map((id) => ({ id })),
      ...(input.cap && { cap: input.cap }),
    },
    sampledUrls: [],
    totalPages: 10,
  } as unknown as AfdocsRun;
}

describe('afdocsCap', () => {
  it('caps at 59 when llms.txt is missing, even though AFDocs reported no cap of its own', () => {
    const cap = afdocsCap(
      run({
        results: [{ id: 'llms-txt-exists', status: 'fail' }],
        checkScores: { 'llms-txt-exists': { proportion: 0, scoreDisplayMode: 'numeric' } },
      }),
    );
    expect(cap).toEqual({
      value: 59,
      checkId: 'llms-txt-exists',
      reason: 'No llms.txt found. Agents lose primary navigation.',
    });
  });

  it('takes the lowest cap when several apply', () => {
    const cap = afdocsCap(
      run({
        results: [{ id: 'llms-txt-exists', status: 'fail' }],
        checkScores: {
          'rendering-strategy': { proportion: 0.2, scoreDisplayMode: 'numeric' },
          'auth-gate-detection': { proportion: 0.5, scoreDisplayMode: 'numeric' },
        },
      }),
    );
    expect(cap?.value).toBe(39);
    expect(cap?.checkId).toBe('rendering-strategy');
  });

  it('ignores critical checks AFDocs could not apply and caps on its diagnostics', () => {
    expect(
      afdocsCap(
        run({
          results: [{ id: 'llms-txt-exists', status: 'pass' }],
          checkScores: { 'rendering-strategy': { proportion: 0, scoreDisplayMode: 'notApplicable' } },
        }),
      ),
    ).toBeUndefined();
    expect(afdocsCap(run({ diagnostics: ['single-page-sample'] }))?.value).toBe(59);
    expect(afdocsCap(run({ diagnostics: ['no-viable-path', 'single-page-sample'] }))?.value).toBe(39);
  });

  it('is what the AFDocs summary carries', () => {
    const summary = summarizeAfdocs(
      run({
        results: [{ id: 'llms-txt-exists', status: 'fail' }],
        checkScores: { 'llms-txt-exists': { proportion: 0, scoreDisplayMode: 'numeric', earnedScore: 0, maxScore: 10 } },
      }),
    );
    expect(summary?.cap?.value).toBe(59);
    expect(summary?.earned).toBe(0);
    expect(summary?.possible).toBe(10);
  });
});
