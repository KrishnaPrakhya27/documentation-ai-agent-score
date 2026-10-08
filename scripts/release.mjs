// Releases the package, by hand: `npm run release` (or `npm run release -- --dry-run`).
//
// 1. Checks: the tree is committed and is what GitHub's main has, and this version is not on npm yet.
// 2. Tests, typechecks and builds, checks that nothing internal ships, and runs the packed CLI.
// 3. Publishes to npm (npm may ask for your one-time password).
// 4. Checks the version is live on npm, and prints the tag to push.
//
// A dry run does steps 1 and 2 and publishes nothing; unpushed commits are only noted.
import { execSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// What npm receives, staged apart from the repository: see stageNpmPackage().
const NPM_PACKAGE_DIR = `${ROOT}.npm-package`;
// The package.json fields installers and the npm page use: `bin` for npx, `optionalDependencies`
// for the AI providers. The repository's scripts and development tools stay behind.
const PUBLISHED_FIELDS = [
  'name', 'version', 'description', 'keywords', 'license', 'author', 'homepage', 'repository', 'bugs',
  'type', 'bin', 'main', 'types', 'exports', 'engines', 'publishConfig', 'dependencies', 'optionalDependencies',
];

// What ships is built code only. Any of these in a published file would expose internals. Two look
// alike but belong: the CLI reads the user's own AI key from `process.env`, and the scanner refuses
// `localhost` and other private hosts.
const FORBIDDEN_IN_RELEASE = [
  ['a source map', /sourceMappingURL|sourcesContent/],
  ['a key', /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}|\b(?:sk|pk|rt)_[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['a local path', /\/Users\/|\/home\/[a-z]/],
  ['an internal service or setting', /tinybird|onrender\.com|inngest|loops\.so|documentationai\.io|AGENT_SCORE_|INTERNAL_API_KEY/i],
];

const isDryRun = process.argv.includes('--dry-run');
const { name, version } = JSON.parse(readFileSync(`${ROOT}package.json`, 'utf8'));

const output = (command, cwd = ROOT) => execSync(command, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
function stop(message) {
  console.error(`\nRelease stopped: ${message}`);
  process.exit(1);
}
function run(command, options = {}) {
  try {
    execSync(command, { cwd: ROOT, stdio: 'inherit', ...options });
  } catch {
    stop(`"${command}" failed (see above). Fix it and run npm run release again.`);
  }
}
const step = (message) => console.log(`\n▸ ${message}`);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isPublishedOnNpm() {
  try {
    return output(`npm view ${name}@${version} version`) === version;
  } catch {
    return false;
  }
}

// The package is open source: what npm gets must be the code anyone can read on GitHub's main.
function notOnGitHubMain() {
  const branch = output('git branch --show-current');
  if (branch !== 'main') return `this is ${branch || 'a detached HEAD'}, not main.`;
  try {
    output('git fetch --quiet origin main');
  } catch {
    return 'could not reach GitHub to compare with origin/main.';
  }
  if (output('git rev-parse HEAD') !== output('git rev-parse origin/main')) return 'main and origin/main differ: push or pull first.';
  return null;
}

/** The npm package, as its own folder: the built code, README, LICENSE and a trimmed package.json. */
function stageNpmPackage() {
  rmSync(NPM_PACKAGE_DIR, { recursive: true, force: true });
  mkdirSync(NPM_PACKAGE_DIR);
  const manifest = JSON.parse(readFileSync(`${ROOT}package.json`, 'utf8'));
  const publishedManifest = Object.fromEntries(
    PUBLISHED_FIELDS.filter((field) => field in manifest).map((field) => [field, manifest[field]]),
  );
  writeFileSync(`${NPM_PACKAGE_DIR}/package.json`, `${JSON.stringify(publishedManifest, null, 2)}\n`);
  for (const file of ['README.md', 'LICENSE']) copyFileSync(`${ROOT}${file}`, `${NPM_PACKAGE_DIR}/${file}`);
  cpSync(`${ROOT}dist`, `${NPM_PACKAGE_DIR}/dist`, { recursive: true, filter: (source) => !source.endsWith('.map') });
  return publishedManifest;
}

/** The staged package, as `npm publish` would pack it: what it would expose. The README's examples rightly name keys. */
function exposedInternals() {
  const [pack] = JSON.parse(output('npm pack --dry-run --json', NPM_PACKAGE_DIR));
  return pack.files
    .map((file) => file.path)
    .filter((path) => path !== 'README.md' && path !== 'LICENSE')
    .flatMap((path) => {
      if (path.endsWith('.map')) return [`${path}: a source map`];
      const text = readFileSync(`${NPM_PACKAGE_DIR}/${path}`, 'utf8');
      return FORBIDDEN_IN_RELEASE.filter(([, pattern]) => pattern.test(text)).map(([what]) => `${path}: ${what}`);
    });
}

/** Each command the package installs, run from the staged copy as `npx` would run it. */
function brokenCommands(manifest) {
  const commands = Object.entries(manifest.bin ?? {});
  if (commands.length === 0) return ['package.json has no "bin": npx could not run the CLI'];
  return commands.flatMap(([command, file]) => {
    try {
      const printed = output(`node ${file} --version`, NPM_PACKAGE_DIR);
      return printed === version ? [] : [`${command} --version printed ${printed}, not ${version}`];
    } catch {
      return [`${command} (${file}) does not run`];
    }
  });
}

// ---- 1. Checks -------------------------------------------------------------
step(`${name}@${version}${isDryRun ? ' (dry run)' : ''}`);
if (output('git status --porcelain')) stop('commit your changes first, so the release matches the repository.');
if (isPublishedOnNpm()) stop(`${version} is already on npm. Bump the version in package.json.`);
const unpushed = notOnGitHubMain();
if (unpushed && !isDryRun) stop(unpushed);
if (unpushed) console.log(`  note: ${unpushed} A real release stops here.`);
if (!isDryRun) {
  try {
    console.log(`  npm user: ${output('npm whoami')}`);
  } catch {
    stop('log in to npm first: npm login');
  }
}

// ---- 2. Test and build -----------------------------------------------------
step('Tests, types and build');
run('npm test');
run('npm run typecheck');
run('npm run build');

step('Checking what ships: no source maps, keys, local paths or internal services');
const publishedManifest = stageNpmPackage();
const leaks = exposedInternals();
if (leaks.length) stop(`these would be published:\n  ${leaks.join('\n  ')}`);
const broken = brokenCommands(publishedManifest);
if (broken.length) stop(`the packed CLI is not right:\n  ${broken.join('\n  ')}`);
console.log('  ok   the npm package, and its CLI runs');

if (isDryRun) {
  console.log(`\nDry run passed. It would publish ${name}@${version} to npm.`);
  process.exit(0);
}

// ---- 3. npm ----------------------------------------------------------------
step(`Publishing ${name}@${version} to npm`);
run('npm publish', { cwd: NPM_PACKAGE_DIR });

// ---- 4. Live check ---------------------------------------------------------
step('Checking npm serves it');
for (let attempt = 0; attempt < 6 && !isPublishedOnNpm(); attempt += 1) await wait(5_000);
if (!isPublishedOnNpm()) stop(`npm accepted ${version} but does not list it yet. Check https://www.npmjs.com/package/${name} in a minute.`);
console.log(`\nReleased ${name}@${version}: https://www.npmjs.com/package/${name}`);
console.log(`Tag it on GitHub: git tag v${version} && git push origin v${version}`);
