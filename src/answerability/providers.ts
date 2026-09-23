import type { LanguageModel } from 'ai';

import type { AnswerabilityModels } from './types';

/**
 * The model providers Answerability may run on, with the models allowed for
 * each role. Whoever runs a scan brings their own key; with none, the scan
 * is technical-only. Provider packages load on demand, so a CLI user needs
 * only the one they chose.
 */

export type AiProvider = 'anthropic' | 'openai' | 'google' | 'gateway';
export type ModelRole = 'questions' | 'solver' | 'judge';

interface ProviderEntry {
  label: string;
  /** Where the CLI looks for the key; keys never come from command-line flags. */
  apiKeyEnv: string;
  allowedModels: string[];
  defaults: Record<ModelRole, string>;
  load: (apiKey: string) => Promise<(modelId: string) => LanguageModel>;
}

export const AI_PROVIDERS: Record<AiProvider, ProviderEntry> = {
  anthropic: {
    label: 'Anthropic',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    allowedModels: ['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-opus-5-5'],
    defaults: {
      questions: 'claude-haiku-4-5-20251001',
      solver: 'claude-haiku-4-5-20251001',
      judge: 'claude-sonnet-5',
    },
    load: async (apiKey) => {
      const { createAnthropic } = await import('@ai-sdk/anthropic');
      const provider = createAnthropic({ apiKey });
      return (modelId) => provider(modelId);
    },
  },
  openai: {
    label: 'OpenAI',
    apiKeyEnv: 'OPENAI_API_KEY',
    allowedModels: ['gpt-5.4-mini', 'gpt-5.4', 'gpt-5-mini', 'gpt-5.2'],
    defaults: { questions: 'gpt-5.4-mini', solver: 'gpt-5.4-mini', judge: 'gpt-5.4' },
    load: async (apiKey) => {
      const { createOpenAI } = await import('@ai-sdk/openai');
      const provider = createOpenAI({ apiKey });
      return (modelId) => provider(modelId);
    },
  },
  google: {
    label: 'Google Gemini',
    apiKeyEnv: 'GOOGLE_GENERATIVE_AI_API_KEY',
    allowedModels: ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro'],
    defaults: { questions: 'gemini-2.5-flash', solver: 'gemini-2.5-flash', judge: 'gemini-2.5-pro' },
    load: async (apiKey) => {
      const { createGoogleGenerativeAI } = await import('@ai-sdk/google');
      const provider = createGoogleGenerativeAI({ apiKey });
      return (modelId) => provider(modelId);
    },
  },
  gateway: {
    label: 'Vercel AI Gateway',
    apiKeyEnv: 'AI_GATEWAY_API_KEY',
    allowedModels: [
      'anthropic/claude-haiku-4.5',
      'anthropic/claude-sonnet-5',
      'anthropic/claude-opus-5.5',
      'openai/gpt-5.4-mini',
      'openai/gpt-5.4',
      'google/gemini-2.5-flash',
      'google/gemini-2.5-pro',
    ],
    defaults: {
      questions: 'anthropic/claude-haiku-4.5',
      solver: 'anthropic/claude-haiku-4.5',
      judge: 'anthropic/claude-sonnet-5',
    },
    load: async (apiKey) => {
      const { createGateway } = await import('@ai-sdk/gateway');
      const provider = createGateway({ apiKey });
      return (modelId) => provider.languageModel(modelId);
    },
  },
};

export interface AiConfig {
  provider: AiProvider;
  apiKey: string;
  /** Per-role overrides; each must be on the provider's allowed list. */
  models?: Partial<Record<ModelRole, string>>;
}

export class AiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiConfigError';
  }
}

export function isAiProvider(value: string): value is AiProvider {
  return value in AI_PROVIDERS;
}

export async function createAnswerabilityModels(config: AiConfig): Promise<AnswerabilityModels> {
  const entry = AI_PROVIDERS[config.provider];
  if (!entry) throw new AiConfigError(`Unknown AI provider "${config.provider}"`);
  if (!config.apiKey) {
    throw new AiConfigError(`${entry.label} needs an API key in ${entry.apiKeyEnv}`);
  }

  const chosen = { ...entry.defaults, ...config.models };
  for (const [role, modelId] of Object.entries(chosen)) {
    if (!entry.allowedModels.includes(modelId)) {
      throw new AiConfigError(
        `${modelId} is not an allowed ${entry.label} model for ${role}. Choose one of: ${entry.allowedModels.join(', ')}`,
      );
    }
  }

  const modelFor = await entry.load(config.apiKey);
  const pick = (role: ModelRole) => ({
    id: modelKey(config.provider, chosen[role]),
    model: modelFor(chosen[role]),
  });
  return { questions: pick('questions'), solver: pick('solver'), judge: pick('judge') };
}

/** Gateway ids already carry a provider prefix; direct ones get theirs added for pricing. */
function modelKey(provider: AiProvider, modelId: string): string {
  return provider === 'gateway' ? modelId : `${provider}/${modelId}`;
}
