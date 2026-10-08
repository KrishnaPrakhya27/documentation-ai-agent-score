# Developing the Agent Score

For anyone working on this repository. This file isn't published to npm; the user guide is the [README](README.md).

```sh
npm install
npm test           # vitest
npm run typecheck
npm run build      # dist/
npm run check -- https://docs.example.com   # the CLI from source
```

## Where it runs

This repository is the engine's only home. The hosted scanner at [documentation.ai/agent-score](https://documentation.ai/agent-score) installs this package, pinned to an exact version, so the website and the CLI give the same scores. A change reaches the website after it is released and the Documentation.AI backend moves to the new version.

## Rules

- Only `src/cli.ts` reads environment variables. Everything else takes its settings as arguments, so the hosted scanner and the CLI run the same code.
- Any change that can move a score needs a new `METHODOLOGY_VERSION` in `src/methodology.ts`, because scores from different versions are not comparable.
- AFDocs is pinned to an exact version. `src/__tests__/packageVersions.vitest.ts` checks it matches `AFDOCS_VERSION`, and that `ENGINE_VERSION` matches `version` in `package.json`.
- The crawler list in `src/checks/crawlerAccess.ts` names each provider's published robots.txt policy and the date it was read; re-read the sources before changing it.

## Releasing

1. Set the new version in `ENGINE_VERSION` (`src/methodology.ts`) and in `package.json` (`npm version <version> --no-git-tag-version`), and bump `METHODOLOGY_VERSION` when scores can move.
2. Commit and push to `main`.
3. `npm run release -- --dry-run` checks everything without publishing; `npm run release` publishes. It stops unless the tree is committed and matches GitHub's `main`, tests, typechecks and builds, checks that the package holds no source maps, keys, local paths or internal services, runs the packed CLI, publishes to npm (npm may ask for your one-time password), and checks that npm serves it. See [scripts/release.mjs](scripts/release.mjs).
4. If npm holds the version for approval, approve it under **Staged Packages** on npmjs.com, then check `npm view @documentation.ai/agent-score version`.
5. Tag it: `git tag v<version> && git push origin v<version>`.
6. For the website, install the new version in the backend: `npm install @documentation.ai/agent-score@<version> --save-exact`.

npm receives a staged copy in `.npm-package/`: the built code, README, LICENSE and a `package.json` cut down to what installers use, so the scripts and dev tools here never ship. Publishing needs an npm account with publish rights in the `documentation.ai` organisation.
