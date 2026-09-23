import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { AFDOCS_VERSION, ENGINE_VERSION } from '../methodology';

const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  version: string;
  dependencies: Record<string, string>;
};

describe('package versions', () => {
  it('reports the version it is published as', () => {
    expect(ENGINE_VERSION).toBe(manifest.version);
  });

  it('pins AFDocs to exactly the version the methodology names', () => {
    expect(manifest.dependencies.afdocs).toBe(AFDOCS_VERSION);
  });
});
