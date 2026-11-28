/** The model family supported by the current chat UI. */
export type ModelKind = 'llm';

/**
 * How a language-model provider is called.
 *
 * `vendor` selects one of the presets below; the preset decides whether it is
 * OpenAI-compatible or needs a dedicated adapter.
 */
export type ModelProtocol = 'openai' | 'anthropic' | 'vendor' | 'code';

export interface ModelKindOption {
  id: ModelKind;
  label: string;
  description: string;
}

export interface VendorPreset {
  id: string;
  label: string;
  kind: ModelKind;
  /** API root used for requests and model discovery. */
  baseUrl: string;
  /** Wire protocol behind this vendor. */
  protocol: 'openai' | 'anthropic' | 'native' | 'code';
  /** Shown in the provider picker. */
  description?: string;
}

export const MODEL_KINDS: ModelKindOption[] = [
  {
    id: 'llm',
    label: '大语言模型',
    description: '聊天、推理、工具调用。当前只支持这一类。',
  },
];

/**
 * Common language-model vendors. OpenAI-compatible vendors are presets only:
 * the regular OpenAI v1 client is used, so they do not need a dedicated adapter.
 */
export const VENDORS: VendorPreset[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    kind: 'llm',
    baseUrl: 'https://api.anthropic.com',
    protocol: 'anthropic',
    description: 'Anthropic Messages API，选择后按 Anthropic 原生接口调用。',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    kind: 'llm',
    baseUrl: 'https://api.openai.com/v1',
    protocol: 'openai',
    description: 'OpenAI 官方 OpenAI v1 兼容接口。',
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    kind: 'llm',
    baseUrl: 'https://api.minimax.io/v1',
    protocol: 'openai',
    description: 'MiniMax 文本模型，OpenAI Chat Completions 兼容。',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    kind: 'llm',
    baseUrl: 'https://api.deepseek.com/v1',
    protocol: 'openai',
    description: 'DeepSeek 官方接口，OpenAI v1 兼容。',
  },
  {
    id: 'moonshot',
    label: 'Moonshot / Kimi',
    kind: 'llm',
    baseUrl: 'https://api.moonshot.cn/v1',
    protocol: 'openai',
    description: 'Moonshot 官方接口，OpenAI v1 兼容。',
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    kind: 'llm',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    protocol: 'openai',
    description: '智谱 GLM 官方接口，OpenAI v1 兼容。',
  },
  {
    id: 'qwen',
    label: '通义千问',
    kind: 'llm',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    protocol: 'openai',
    description: '阿里云 DashScope 的 OpenAI 兼容模式。',
  },
  {
    id: 'xai',
    label: 'xAI Grok',
    kind: 'llm',
    baseUrl: 'https://api.x.ai/v1',
    protocol: 'openai',
    description: 'xAI Grok 官方接口，OpenAI v1 兼容。',
  },
  {
    id: 'google',
    label: 'Google Gemini',
    kind: 'llm',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    protocol: 'openai',
    description: 'Gemini 的 OpenAI 兼容入口，不需要单独适配。',
  },
  {
    id: 'volcengine',
    label: '火山方舟 / 豆包',
    kind: 'llm',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    protocol: 'openai',
    description: '火山引擎方舟的 OpenAI 兼容接口。',
  },
  {
    id: 'hunyuan',
    label: '腾讯混元',
    kind: 'llm',
    baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
    protocol: 'openai',
    description: '腾讯混元 OpenAI 兼容接口。',
  },
  {
    id: 'baichuan',
    label: '百川智能',
    kind: 'llm',
    baseUrl: 'https://api.baichuan-ai.com/v1',
    protocol: 'openai',
    description: '百川智能 OpenAI 兼容接口。',
  },
  {
    id: 'siliconflow',
    label: 'SiliconFlow',
    kind: 'llm',
    baseUrl: 'https://api.siliconflow.cn/v1',
    protocol: 'openai',
    description: 'SiliconFlow 的 OpenAI 兼容接口。',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    kind: 'llm',
    baseUrl: 'https://openrouter.ai/api/v1',
    protocol: 'openai',
    description: 'OpenRouter 聚合接口，OpenAI v1 兼容。',
  },
  {
    id: 'groq',
    label: 'Groq',
    kind: 'llm',
    baseUrl: 'https://api.groq.com/openai/v1',
    protocol: 'openai',
    description: 'Groq 的 OpenAI 兼容接口。',
  },
  {
    id: 'mistral',
    label: 'Mistral',
    kind: 'llm',
    baseUrl: 'https://api.mistral.ai/v1',
    protocol: 'openai',
    description: 'Mistral 的 OpenAI 兼容接口。',
  },
  {
    id: 'together',
    label: 'Together AI',
    kind: 'llm',
    baseUrl: 'https://api.together.xyz/v1',
    protocol: 'openai',
    description: 'Together AI 的 OpenAI 兼容接口。',
  },
  {
    id: 'cohere',
    label: 'Cohere',
    kind: 'llm',
    baseUrl: 'https://api.cohere.com/compatibility/v1',
    protocol: 'openai',
    description: 'Cohere 的 OpenAI 兼容入口。',
  },
  {
    id: 'ollama',
    label: 'Ollama（本机）',
    kind: 'llm',
    baseUrl: 'http://127.0.0.1:11434/v1',
    protocol: 'openai',
    description: '本机 Ollama 的 OpenAI 兼容接口。',
  },
];

export function vendorOptions(kind: ModelKind): VendorPreset[] {
  return VENDORS.filter((vendor) => vendor.kind === kind);
}

export function findVendor(id: string): VendorPreset | undefined {
  return VENDORS.find((vendor) => vendor.id === id);
}

/** Protocols offered for the only supported category. */
export function protocolsFor(_kind: ModelKind): Array<{ id: ModelProtocol; label: string }> {
  return [
    { id: 'vendor', label: '厂商集成' },
    { id: 'openai', label: 'OpenAI v1' },
    { id: 'code', label: '代码接入' },
  ];
}

/** Resolve the wire protocol a stored provider actually uses. */
export function effectiveProtocol(provider: {
  kind: ModelKind;
  protocol: ModelProtocol;
  vendor?: string;
}): 'openai' | 'anthropic' | 'native' | 'code' {
  if (provider.protocol === 'vendor') {
    return findVendor(provider.vendor ?? '')?.protocol ?? 'native';
  }
  if (provider.protocol === 'anthropic') return 'anthropic';
  if (provider.protocol === 'code') return 'code';
  return 'openai';
}

/** Whether this provider can be selected as the active chat model. */
export function isChatProvider(provider: {
  kind: ModelKind;
  protocol: ModelProtocol;
  vendor?: string;
}): boolean {
  if (provider.kind !== 'llm') return false;
  const protocol = effectiveProtocol(provider);
  return protocol === 'openai' || protocol === 'anthropic';
}
