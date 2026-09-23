import { describe, expect, it } from 'vitest';

import type { AccessResult, AnswerabilityResult, FreshnessResult, PillarState } from '../report.types';
import { overallScore } from '../scoring';

function access(score: number | null, state: PillarState = 'complete'): AccessResult {
  return { state, score, profile: 'developer-docs', afdocs: null };
}

function answerability(score: number | null, state: PillarState = 'complete'): AnswerabilityResult {
  return { state, score, passed: 0, total: 0, transcript: [] };
}

function freshness(score: number | null, state: PillarState = 'complete'): FreshnessResult {
  return { state, score, components: [] };
}

describe('overallScore', () => {
  it('weights all three pillars 40/40/20 when each was measured', () => {
    const overall = overallScore({ access: access(80), answerability: answerability(60), freshness: freshness(50) });
    expect(overall).toEqual({ score: 66, grade: 'D' });
  });

  it('grades from Access and Freshness when Answerability was not tested', () => {
    const overall = overallScore({
      access: access(85),
      answerability: answerability(null, 'unavailable'),
      freshness: freshness(71),
    });
    expect(overall.score).toBe(80);
    expect(overall.grade).toBe('B');
    expect(overall.reason).toBe('Based on Access and Freshness. Answerability was not measured for this scan.');
  });

  it('gives a provisional grade while Answerability is still running', () => {
    const overall = overallScore({
      access: access(90),
      answerability: answerability(null, 'pending'),
      freshness: freshness(90),
    });
    expect(overall).toMatchObject({ score: 90, grade: 'A' });
    expect(overall.reason).toMatch(/Answerability is still being tested and will update this score/);
  });

  it('rounds a reweighted .5 up, as the full composite does', () => {
    const overall = overallScore({
      access: access(85),
      answerability: answerability(80),
      freshness: freshness(null, 'unavailable'),
    });
    expect(overall.score).toBe(83);
    expect(overall.reason).toBe('Based on Access and Answerability. Freshness was not measured for this scan.');
  });

  it('has no grade without Access, whatever else was measured', () => {
    const overall = overallScore({
      access: access(null, 'unavailable'),
      answerability: answerability(90),
      freshness: freshness(90),
    });
    expect(overall.score).toBeNull();
    expect(overall.grade).toBeNull();
    expect(overall.reason).toMatch(/Access could not be measured/);
  });
});
