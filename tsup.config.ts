import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', cli: 'src/cli.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  dts: { entry: { index: 'src/index.ts' } },
  sourcemap: true,
  clean: true,
  // The AI provider SDKs are optional dependencies, loaded only when Answerability runs.
  external: [/^@ai-sdk\//],
});
