#!/usr/bin/env node
import {
  AI_PROVIDERS,
  createAnswerabilityModels,
  isAiProvider,
  type ModelRole,
} from './answerability/providers';
import { ENGINE_VERSION } from './methodology';
import type { AgentScoreReport, ContentProfile } from './report.types';
import { scanSite, type ScanSiteOptions, type ScanSiteResult } from './scanSite';

/**
 * `npx @documentation.ai/agent-score check <url>`, or `npx tsx <this file>
 * check <url>` from source: scans a docs site from this machine and prints the
 * report. Answerability runs only with --ai and that provider's key in its
 * usual environment variable. Nothing is uploaded.
 */

const USAGE = `Usage: agent-score check <url> [options]

Options:
  --json                        Print the full report as JSON
  --profile <profile>           Score as developer-docs or help-center instead of detecting it
  --ai <provider>               Also test answering: ${Object.keys(AI_PROVIDERS).join(', ')}
                                (reads that provider's API key from its usual environment variable)
  --ai-models <role=model,...>  Override models for questions, solver or judge
  --version                     Print the version
  --help                        Print this help
`;

async function main(): Promise<void> {
  try {
    await runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 3;
  }
}

async function runCli(args: string[]): Promise<void> {
  if (args.includes('--version')) {
    process.stdout.write(`${ENGINE_VERSION}\n`);
    return;
  }
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(USAGE);
    return;
  }
  const [command, url, ...flags] = args;
  if (command !== 'check' || !url) {
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return;
  }

  const started = Date.now();
  const { report, answerabilityCostUsd } = await scanWithProgress(url, {
    models: await modelsFromFlags(flags),
    profile: profileFromFlags(flags),
  });
  if (answerabilityCostUsd > 0) process.stderr.write(`Answerability cost about $${answerabilityCostUsd}\n`);

  if (flags.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(summarize(report, Date.now() - started));
  }
}

async function scanWithProgress(url: string, options: ScanSiteOptions): Promise<ScanSiteResult> {
  const progress = progressLine(process.stderr);
  try {
    return await scanSite(url, { ...options, onProgress: progress.update });
  } finally {
    progress.stop();
  }
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

interface ProgressLine {
  update: (message: string) => void;
  stop: () => void;
}

/**
 * On a terminal, one line that redraws with a spinner, the seconds so far and
 * the scan's latest step. Elsewhere (CI, a pipe), one plain line per new step.
 */
function progressLine(stream: NodeJS.WriteStream): ProgressLine {
  if (!stream.isTTY) {
    let lastStep = '';
    return {
      update: (message) => {
        const step = message.split(':')[0];
        if (step === lastStep) return;
        lastStep = step;
        stream.write(`${message}\n`);
      },
      stop: () => {},
    };
  }

  const started = Date.now();
  let message = '';
  let frame = 0;
  const draw = () => {
    const seconds = Math.round((Date.now() - started) / 1000);
    const line = `${SPINNER_FRAMES[frame % SPINNER_FRAMES.length]} ${seconds}s  ${message}`;
    frame += 1;
    stream.write(`\r\x1b[2K${line.slice(0, (stream.columns || 80) - 1)}`);
  };
  const timer = setInterval(draw, 100);
  timer.unref();
  return {
    update: (next) => {
      message = next;
      draw();
    },
    stop: () => {
      clearInterval(timer);
      stream.write('\r\x1b[2K');
    },
  };
}

function flagValue(flags: string[], name: string): string | null {
  const index = flags.indexOf(name);
  return index === -1 ? null : (flags[index + 1] ?? '');
}

function profileFromFlags(flags: string[]): ContentProfile | undefined {
  const profile = flagValue(flags, '--profile');
  if (profile === null) return undefined;
  if (profile === 'developer-docs' || profile === 'help-center') return profile;
  throw new Error('--profile must be developer-docs or help-center');
}

/** Answerability models from `--ai`, with the key read from that provider's own env var. */
async function modelsFromFlags(flags: string[]) {
  const provider = flagValue(flags, '--ai');
  if (provider === null) return null;
  if (!isAiProvider(provider)) {
    throw new Error(`--ai must be one of: ${Object.keys(AI_PROVIDERS).join(', ')}`);
  }

  const overrides: Partial<Record<ModelRole, string>> = {};
  for (const pair of (flagValue(flags, '--ai-models') ?? '').split(',').filter(Boolean)) {
    const [role, modelId] = pair.split('=');
    if (role === 'questions' || role === 'solver' || role === 'judge') overrides[role] = modelId;
  }
  return createAnswerabilityModels({
    provider,
    apiKey: process.env[AI_PROVIDERS[provider].apiKeyEnv] ?? '',
    models: overrides,
  });
}

function summarize(report: AgentScoreReport, elapsedMs: number): string {
  const { overall, afdocs, groups } = report;
  const lines = [
    `${report.site.name}: ${report.target.key} (${report.platform.name}, ${report.target.profile})`,
    ...(report.target.submittedUrl.replace(/\/+$/, '') !== report.target.scopeRoot.replace(/\/+$/, '')
      ? [`Redirected from ${report.target.submittedUrl}`]
      : []),
    ...(report.coverage.rateLimitedRequests > 0
      ? [`The site refused ${report.coverage.rateLimitedRequests} requests as too many; results may read low`]
      : []),
    `Score ${overall.score ?? 'n/a'} ${overall.grade ?? ''}${overall.provisional ? ' (provisional)' : ''}: ${overall.earned}/${overall.possible} points`,
    ...(overall.cap ? [`Capped at ${overall.cap.value}: ${overall.cap.reason}`] : []),
    ...(afdocs
      ? [`AFDocs ${afdocs.score}/${afdocs.grade} (${afdocs.passed}/${afdocs.total} checks, ${afdocs.earned}/${afdocs.possible} points)`]
      : []),
    ...Object.values(groups).map(
      (group) => `${group.label} ${group.score ?? 'n/a'}  (${group.earned}/${group.possible} points${group.note ? `; ${group.note}` : ''})`,
    ),
    `Pages tested ${report.coverage.pagesTested}/${report.coverage.pagesDiscovered}, ${report.coverage.requests} requests, ${(elapsedMs / 1000).toFixed(1)}s`,
    '',
    ...report.checks.map(
      (check) =>
        `${check.status.padEnd(10)} ${String(check.points.earned ?? '-').padStart(4)}/${String(check.points.max).padEnd(4)} ${check.id.padEnd(30)} ${check.message.slice(0, 90)}`,
    ),
    ...report.additionalChecks.map(
      (check) => `${check.status.padEnd(10)} ${'not scored'.padEnd(9)} ${check.id.padEnd(30)} ${check.message.slice(0, 90)}`,
    ),
    '',
    ...report.answerability.transcript.map(
      (entry) => `Q [${entry.verdict}] ${entry.question}\n   → ${entry.answer.slice(0, 160).replace(/\s+/g, ' ')}\n   why: ${entry.reason}`,
    ),
    '',
    'Top fixes:',
    ...report.topFixes.map((fix, index) => `${index + 1}. ${fix.title} (+${fix.points} points): ${fix.fix.slice(0, 140)}`),
    '',
  ];
  return lines.join('\n');
}

void main();
