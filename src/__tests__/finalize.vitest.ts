import { describe, expect, it } from 'vitest';

import { emptyAnswerability } from '../answerability/runAnswerability';
import { finalLimitations } from '../finalize';
import { nameFromDomain } from '../reportText';
import type { OverallScore } from '../report.types';

const overall = (provisional: boolean, reasons: string[] = []): OverallScore => ({
  score: 80,
  grade: 'B',
  earned: 80,
  possible: 100,
  provisional,
  provisionalReasons: reasons,
});

describe('finalLimitations', () => {
  const technical = ['Based on 10 sampled pages.', 'The score is provisional: Only 4 pages could be read.'];

  it('drops the provisional note when the final score stands, and restates it when it does not', () => {
    expect(finalLimitations(technical, overall(false), emptyAnswerability('unavailable', 'No model.'))).toEqual([
      'Based on 10 sampled pages.',
      'No model.',
    ]);
    expect(finalLimitations(['Based on 10 sampled pages.'], overall(true, ['Too much unverified.']), { ...emptyAnswerability('unavailable'), state: 'complete' as const })).toEqual([
      'Based on 10 sampled pages.',
      'The score is provisional: Too much unverified.',
    ]);
  });
});

describe('nameFromDomain', () => {
  it('names a site by its registrable label, whatever the suffix', () => {
    expect(nameFromDomain('docs.example.co.uk')).toBe('Example');
    expect(nameFromDomain('example.com.au')).toBe('Example');
    expect(nameFromDomain('acme.github.io')).toBe('Acme');
    expect(nameFromDomain('docs.stripe.com')).toBe('Stripe');
  });
});
