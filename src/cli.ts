#!/usr/bin/env node
import {
  AI_PROVIDERS,
  createAnswerabilityModels,
  isAiProvider,
  type ModelRole,
} from './answerability/providers';
import { ENGINE_VERSION } from './methodology';
import type { AgentScoreReport, ContentProfile } from './report.types';
import { scanSite } from './scanSite';

/**
 * `npx @documentation-ai/agent-score check <url>`: scans a docs site from this
 * machine and prints the report. Answerability runs only with --ai and that
 * provider's key in its usual environment variable. Nothing is uploaded.
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
  const { report, answerabilityCostUsd } = await scanSite(url, {
    models: await modelsFromFlags(flags),
    profile: profileFromFlags(flags),
    onProgress: (message) => process.stderr.write(`${message}\n`),
  });
  if (answerabilityCostUsd > 0) process.stderr.write(`Answerability cost about $${answerabilityCostUsd}\n`);

  if (flags.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(summarize(report, Date.now() - started));
  }
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
  const { access, freshness } = report.pillars;
  const lines = [
    `${report.site.name} — ${report.target.key} (${report.platform.name}, ${report.target.profile})`,
    `Access ${access.score ?? '—'}  (AFDocs ${access.afdocs?.passed}/${access.afdocs?.total}, ${access.afdocs?.score}/${access.afdocs?.grade})`,
    `Freshness ${freshness.score ?? '—'}  ${freshness.components.map((c) => `${c.id}=${c.score ?? 'n/a'}`).join(' ')}`,
    `Answerability ${report.pillars.answerability.score ?? '—'}  (${report.pillars.answerability.passed}/${report.pillars.answerability.total})  Overall ${report.overall.score ?? '—'} ${report.overall.grade ?? ''}`,
    `Pages tested ${report.coverage.pagesTested}/${report.coverage.pagesDiscovered}, ${report.coverage.requests} requests, ${(elapsedMs / 1000).toFixed(1)}s`,
    '',
    ...report.checks.map((check) => `${check.status.padEnd(5)} ${check.scored ? ' ' : '~'} ${check.id.padEnd(30)} ${check.message.slice(0, 100)}`),
    '',
    ...report.pillars.answerability.transcript.map(
      (entry) => `Q [${entry.verdict}] ${entry.question}\n   → ${entry.answer.slice(0, 160).replace(/\s+/g, ' ')}\n   why: ${entry.reason}`,
    ),
    '',
    'Top fixes:',
    ...report.topFixes.map((fix, index) => `${index + 1}. ${fix.title}: ${fix.fix.slice(0, 140)}`),
    '',
  ];
  return lines.join('\n');
}

void main();
