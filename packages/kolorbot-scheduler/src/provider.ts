import { existsSync, readFileSync } from 'node:fs';
import type { ModelTarget } from './model-target.js';

interface ProviderFile {
  active?: { providerId?: string; model?: string } | null;
  providers?: Array<{
    id?: string;
    baseUrl?: string;
    apiKey?: string;
    models?: string[];
  }>;
}

/**
 * Resolve the active model without depending on the web package.
 *
 * providers.json is the source of truth; the environment is only a fallback
 * (matching the web UI's behaviour). Returns `undefined` when nothing usable is
 * configured.
 */
export function resolveActiveTarget(
  providersPath: string,
  env: NodeJS.ProcessEnv = process.env,
): ModelTarget | undefined {
  if (existsSync(providersPath)) {
    try {
      const raw = readFileSync(providersPath, 'utf8').replace(/^\uFEFF/, '');
      const file = JSON.parse(raw) as ProviderFile;
      const active = file.active;
      if (active?.providerId !== undefined) {
        const provider = file.providers?.find((entry) => entry.id === active.providerId);
        const baseUrl = provider?.baseUrl?.trim() ?? '';
        const apiKey = provider?.apiKey ?? '';
        const model = (active.model?.trim() || provider?.models?.[0] || '').trim();
        if (baseUrl !== '' && apiKey !== '' && model !== '') {
          return { apiUrl: baseUrl, apiModelName: model, apiKey };
        }
      }
    } catch {
      // fall through to the environment fallback
    }
  }

  const apiUrl = env.KOLOR_API_URL?.trim() ?? '';
  const apiModelName = env.KOLOR_API_MODEL?.trim() ?? '';
  const apiKey = (env.KOLOR_API_KEY ?? env.DEEPSEEK_API_KEY ?? '').trim();
  if (apiUrl !== '' && apiModelName !== '' && apiKey !== '') {
    return { apiUrl, apiModelName, apiKey };
  }
  return undefined;
}
