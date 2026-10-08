# Developing the Agent Score

For anyone working on this repository. This file isn't published to npm; the user guide is the [README](README.md).

```sh
npm install
npm test           # vitest
npm run typecheck
npm run build      # dist/
npm run check -- https://docs.example.com   # the CLI from source
```

## Where the code comes from

`src/` is the engine of the hosted scanner at [documentation.ai/agent-score](https://documentation.ai/agent-score), copied here unchanged so the website and this package give the same scores. The Documentation.AI team changes the engine in its backend first, then copies it over:

```sh
rsync -a --delete --exclude='/README.md' --exclude='/__tests__/packageVersions.vitest.ts' \
  ../documentation-ai-backend/src/services/agent-score/ src/
```

`src/__tests__/packageVersions.vitest.ts` belongs to this repository: it checks that AFDocs is pinned to the version the methodology names, and that `ENGINE_VERSION` matches `version` in `package.json`.

A pull request merged here also has to be made in the backend, or the next copy removes it.

## Releasing

1. In the backend, bump `ENGINE_VERSION` in `methodology.ts` (and `METHODOLOGY_VERSION` when scores can move), then copy the engine over and set the same `version` in `package.json`.
2. Commit and push to `main`.
3. `npm run release -- --dry-run` checks everything without publishing; `npm run release` publishes. It stops unless the tree is committed and matches GitHub's `main`, tests, typechecks and builds, checks that the package holds no source maps, keys, local paths or internal services, runs the packed CLI, publishes to npm (npm may ask for your one-time password), and checks that npm serves it. See [scripts/release.mjs](scripts/release.mjs).
4. Tag it: `git tag v<version> && git push origin v<version>`.

npm receives a staged copy in `.npm-package/`: the built code, README, LICENSE and a `package.json` cut down to what installers use, so the scripts and dev tools here never ship. Publishing needs an npm account with publish rights in the `documentation.ai` organisation.
