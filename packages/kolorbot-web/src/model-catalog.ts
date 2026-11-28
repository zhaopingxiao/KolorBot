/** Model capability families exposed by the provider form. */
export type ModelKind = 'llm' | 'speech' | 'image' | 'video';

/**
 * How a provider is called.
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
  /** Known model ids; the UI can use these as suggestions. */
  models?: string[];
  /** Shown in the provider picker. */
  description?: string;
}

export const MODEL_KINDS: ModelKindOption[] = [
  {
    id: 'llm',
    label: '大语言模型',
    description: '聊天、推理、工具调用；目前聊天只使用这一类。',
  },
  {
    id: 'speech',
    label: '语音生成模型',
    description: '文字转语音、语音克隆等。接口已预留，暂未接入聊天。',
  },
  {
    id: 'image',
    label: '图片生成模型',
    description: '文生图、图生图等。接口已预留，暂未接入聊天。',
  },
  {
    id: 'video',
    label: '视频生成模型',
    description: '文生视频、图生视频等。接口已预留，暂未接入聊天。',
  },
];

/**
 * Common vendors. OpenAI-compatible vendors are presets only: the regular
 * OpenAI v1 client is used, so they do not need a dedicated adapter.
 */
export const VENDORS: VendorPreset[] = [
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
    id: 'openai-speech',
    label: 'OpenAI 语音',
    kind: 'speech',
    baseUrl: 'https://api.openai.com/v1',
    protocol: 'openai',
    description: '预留：OpenAI Audio / TTS 接口。',
  },
  {
    id: 'minimax-speech',
    label: 'MiniMax 语音',
    kind: 'speech',
    baseUrl: 'https://api.minimax.io/v1',
    protocol: 'native',
    description: '预留：MiniMax 语音接口。',
  },
  {
    id: 'elevenlabs',
    label: 'ElevenLabs',
    kind: 'speech',
    baseUrl: 'https://api.elevenlabs.io/v1',
    protocol: 'native',
    description: '预留：ElevenLabs 文本转语音接口。',
  },
  {
    id: 'openai-image',
    label: 'OpenAI 图片',
    kind: 'image',
    baseUrl: 'https://api.openai.com/v1',
    protocol: 'openai',
    description: '预留：OpenAI Images 接口。',
  },
  {
    id: 'stability',
    label: 'Stability AI',
    kind: 'image',
    baseUrl: 'https://api.stability.ai',
    protocol: 'native',
    description: '预留：Stability AI 图片生成接口。',
  },
  {
    id: 'runway',
    label: 'Runway',
    kind: 'video',
    baseUrl: 'https://api.dev.runwayml.com/v1',
    protocol: 'native',
    description: '预留：Runway 视频生成接口。',
  },
];

export function vendorOptions(kind: ModelKind): VendorPreset[] {
  return VENDORS.filter((vendor) => vendor.kind === kind);
}

export function findVendor(id: string): VendorPreset | undefined {
  return VENDORS.find((vendor) => vendor.id === id);
}

/** Protocols offered for a category. LLM has Anthropic; code is last for all. */
export function protocolsFor(kind: ModelKind): Array<{ id: ModelProtocol; label: string }> {
  const base: Array<{ id: ModelProtocol; label: string }> = [
    { id: 'openai', label: 'OpenAI v1' },
  ];
  if (kind === 'llm') base.push({ id: 'anthropic', label: 'Anthropic' });
  base.push(
    { id: 'vendor', label: '厂商专用' },
    { id: 'code', label: '代码接入' },
  );
  return base;
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
