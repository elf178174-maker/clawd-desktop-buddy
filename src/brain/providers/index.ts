// Builds the configured model provider. This is the only place that knows about specific vendors.

import type { ProviderId, Settings } from '../../shared/settings'
import { AnthropicProvider } from './anthropic'
import { GeminiProvider } from './gemini'
import { OllamaProvider } from './ollama'
import { OpenAIProvider } from './openai'
import { ProviderError, type ModelProvider } from './types'

/** `forListing` skips the model check so the model list can be fetched before one is chosen. */
export async function createProvider(s: Settings, getKey: (id: ProviderId) => Promise<string | null>, id: ProviderId = s.ai.provider, forListing = false): Promise<ModelProvider> {
  const ai = s.ai
  const pick = (m: string) => m || (forListing ? 'list' : '')
  switch (id) {
    case 'ollama':
      return new OllamaProvider(ai.ollama.baseUrl, ai.ollama.model, ai.ollama.numCtx, ai.ollama.keepAlive)
    case 'openai': {
      const key = await getKey('openai')
      if (!key) throw new ProviderError('No OpenAI API key is set. Add one in Settings > AI.', 'auth')
      if (!pick(ai.openai.model)) throw new ProviderError('Choose an OpenAI model in Settings > AI.', 'bad_request')
      return new OpenAIProvider('openai', 'OpenAI', ai.openai.baseUrl, pick(ai.openai.model), key)
    }
    case 'compatible': {
      if (!ai.compatible.baseUrl) throw new ProviderError('Set the server address for the OpenAI-compatible provider in Settings > AI.', 'bad_request')
      if (!pick(ai.compatible.model)) throw new ProviderError('Choose a model for the OpenAI-compatible provider in Settings > AI.', 'bad_request')
      return new OpenAIProvider('compatible', ai.compatible.name || 'Custom', ai.compatible.baseUrl, pick(ai.compatible.model), await getKey('compatible'))
    }
    case 'anthropic':
      return new AnthropicProvider(ai.anthropic.baseUrl, ai.anthropic.model, await getKey('anthropic'))
    case 'gemini': {
      const key = await getKey('gemini')
      if (!key) throw new ProviderError('No Gemini API key is set. Add one in Settings > AI.', 'auth')
      if (!pick(ai.gemini.model)) throw new ProviderError('Choose a Gemini model in Settings > AI.', 'bad_request')
      return new GeminiProvider(ai.gemini.baseUrl, pick(ai.gemini.model), key)
    }
  }
}
