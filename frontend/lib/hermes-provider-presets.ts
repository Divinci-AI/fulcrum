/**
 * Curated OpenAI-compatible provider presets for the Hermes Settings panel.
 *
 * The Hermes integration accepts any OpenAI-compatible endpoint with bearer
 * auth — but operators have to know the magic URL format ahead of time.
 * These presets pre-fill the Base URL field on selection and surface model
 * suggestions so the operator doesn't have to look up which model strings
 * are available.
 *
 * Keep the `id: 'custom'` entry as the catch-all for endpoints we haven't
 * curated yet. New presets can be added without code changes elsewhere —
 * the Settings UI iterates this array directly.
 */
export interface HermesProviderPreset {
  id: string
  /** Short display label for the dropdown. */
  label: string
  /** Pre-filled Base URL. Empty string for 'custom'. */
  baseUrl: string
  /** Comma-separated model suggestions shown as helper text. */
  modelSuggestions: string[]
  /** One-line description shown under the dropdown when this preset is selected. */
  description: string
  /** Optional link to the provider's docs / API key page. */
  docsUrl?: string
}

export const HERMES_PROVIDER_PRESETS: HermesProviderPreset[] = [
  {
    id: 'gemini',
    label: 'Google Gemini (AI Studio)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    modelSuggestions: ['gemini-3.5-flash', 'gemini-3-pro', 'gemini-3.5'],
    description: 'Free-tier Gemini via Google AI Studio. Simple API key, no GCP setup.',
    docsUrl: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    modelSuggestions: [
      'openai/gpt-4o-mini',
      'anthropic/claude-3.5-sonnet',
      'google/gemini-2.5-flash',
      'meta-llama/llama-3.3-70b-instruct',
    ],
    description: 'OpenRouter aggregator — 200+ models behind one OpenAI-compatible API.',
    docsUrl: 'https://openrouter.ai/keys',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    modelSuggestions: ['gpt-4o-mini', 'gpt-4o', 'gpt-5'],
    description: 'OpenAI direct. Get a key at platform.openai.com/api-keys.',
    docsUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'hermes-local',
    label: 'Hermes Agent (local)',
    baseUrl: 'http://localhost:8642',
    modelSuggestions: ['Hermes-4-70B', 'Hermes-4.3-36B', 'Hermes-4-405B'],
    description: 'Nous Research hermes-agent CLI running locally via `hermes gateway`.',
    docsUrl: 'https://hermes-agent.nousresearch.com/docs/',
  },
  {
    id: 'zai',
    label: 'z.ai (GLM)',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    modelSuggestions: ['glm-5.1', 'glm-5-turbo', 'glm-4.7'],
    description: 'z.ai GLM models via their OpenAI-compatible endpoint (NOT the Anthropic shim).',
    docsUrl: 'https://docs.z.ai/guides/overview/quick-start',
  },
  {
    id: 'custom',
    label: 'Custom',
    baseUrl: '',
    modelSuggestions: [],
    description: 'Any other OpenAI-compatible endpoint with bearer auth.',
  },
]

/**
 * Match a base URL back to a preset id (for displaying the right preset as
 * currently-selected on settings load). Returns 'custom' when no match.
 */
export function detectPresetFromBaseUrl(baseUrl: string | null | undefined): string {
  if (!baseUrl) return 'custom'
  const normalized = baseUrl.replace(/\/+$/, '').toLowerCase()
  for (const preset of HERMES_PROVIDER_PRESETS) {
    if (preset.id === 'custom') continue
    if (preset.baseUrl && normalized === preset.baseUrl.replace(/\/+$/, '').toLowerCase()) {
      return preset.id
    }
  }
  return 'custom'
}
