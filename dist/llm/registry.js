import { OllamaProvider } from './ollama.js';
import { OpenAICompatProvider } from './openai-compat.js';
export function createProvider(name, cfg) {
    switch (cfg.type) {
        case 'ollama':
            return new OllamaProvider(name, cfg);
        case 'openai':
            return new OpenAICompatProvider(name, cfg);
        default: {
            const t = cfg.type;
            throw new Error(`Noma'lum provider turi: ${t}`);
        }
    }
}
export function createProviderFromConfig(config, name = config.defaultProvider) {
    const cfg = config.providers[name];
    if (!cfg) {
        throw new Error(`Provider "${name}" config'da yo'q. Mavjud: ${Object.keys(config.providers).join(', ')}`);
    }
    return createProvider(name, cfg);
}
//# sourceMappingURL=registry.js.map