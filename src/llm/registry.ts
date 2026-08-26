import type { Config, ProviderConfig } from '../config/schema.js';
import { OllamaProvider } from './ollama.js';
import { OpenAICompatProvider } from './openai-compat.js';
import type { LLMProvider } from './types.js';

export function createProvider(name: string, cfg: ProviderConfig): LLMProvider {
  switch (cfg.type) {
    case 'ollama':
      return new OllamaProvider(name, cfg);
    case 'openai':
      return new OpenAICompatProvider(name, cfg);
    default: {
      const t = (cfg as { type: string }).type;
      throw new Error(`Noma'lum provider turi: ${t}`);
    }
  }
}

export function createProviderFromConfig(config: Config, name = config.defaultProvider): LLMProvider {
  const cfg = config.providers[name];
  if (!cfg) {
    throw new Error(`Provider "${name}" config'da yo'q. Mavjud: ${Object.keys(config.providers).join(', ')}`);
  }
  return createProvider(name, cfg);
}
