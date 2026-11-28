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
  {
    id: 'openai-speech',
    label: 'OpenAI 语音',
    kind: 'speech',
    baseUrl: 'https://api.openai.com/v1',
    protocol: 'native',
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
    id: 'google-tts',
    label: 'Google Cloud TTS',
    kind: 'speech',
    baseUrl: 'https://texttospeech.googleapis.com/v1',
    protocol: 'native',
    description: '预留：Google Cloud Text-to-Speech。',
  },
  {
    id: 'amazon-polly',
    label: 'Amazon Polly',
    kind: 'speech',
    baseUrl: 'https://polly.us-east-1.amazonaws.com',
    protocol: 'native',
    description: '预留：Amazon Polly（区域按账号调整）。',
  },
  {
    id: 'deepgram-tts',
    label: 'Deepgram Aura',
    kind: 'speech',
    baseUrl: 'https://api.deepgram.com/v1',
    protocol: 'native',
    description: '预留：Deepgram Aura 文本转语音。',
  },
  {
    id: 'cartesia',
    label: 'Cartesia',
    kind: 'speech',
    baseUrl: 'https://api.cartesia.ai',
    protocol: 'native',
    description: '预留：Cartesia 实时语音接口。',
  },
  {
    id: 'playht',
    label: 'PlayHT',
    kind: 'speech',
    baseUrl: 'https://api.play.ht/api/v2',
    protocol: 'native',
    description: '预留：PlayHT 文本转语音。',
  },
  {
    id: 'fish-audio',
    label: 'Fish Audio',
    kind: 'speech',
    baseUrl: 'https://api.fish.audio',
    protocol: 'native',
    description: '预留：Fish Audio 语音合成。',
  },
  {
    id: 'dashscope-cosyvoice',
    label: '通义 CosyVoice',
    kind: 'speech',
    baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
    protocol: 'native',
    description: '预留：阿里云百炼 CosyVoice。',
  },
  {
    id: 'volcengine-speech',
    label: '火山语音',
    kind: 'speech',
    baseUrl: 'https://openspeech.bytedance.com/api/v1',
    protocol: 'native',
    description: '预留：火山引擎豆包语音合成。',
  },
  {
    id: 'tencent-tts',
    label: '腾讯云 TTS',
    kind: 'speech',
    baseUrl: 'https://tts.tencentcloudapi.com',
    protocol: 'native',
    description: '预留：腾讯云语音合成。',
  },
  {
    id: 'xfyun-tts',
    label: '讯飞语音',
    kind: 'speech',
    baseUrl: 'https://tts-api.xfyun.cn/v2/tts',
    protocol: 'native',
    description: '预留：讯飞在线语音合成。',
  },
  {
    id: 'baidu-tts',
    label: '百度语音',
    kind: 'speech',
    baseUrl: 'https://tsn.baidu.com/text2audio',
    protocol: 'native',
    description: '预留：百度短文本在线合成。',
  },
  {
    id: 'openai-image',
    label: 'OpenAI 图片',
    kind: 'image',
    baseUrl: 'https://api.openai.com/v1',
    protocol: 'native',
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
    id: 'google-imagen',
    label: 'Google Imagen',
    kind: 'image',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    protocol: 'native',
    description: '预留：Google Imagen 图片生成。',
  },
  {
    id: 'black-forest-labs',
    label: 'Black Forest Labs / FLUX',
    kind: 'image',
    baseUrl: 'https://api.bfl.ai/v1',
    protocol: 'native',
    description: '预留：FLUX 图片生成 API。',
  },
  {
    id: 'replicate-image',
    label: 'Replicate 图片',
    kind: 'image',
    baseUrl: 'https://api.replicate.com/v1',
    protocol: 'native',
    description: '预留：Replicate 图片模型。',
  },
  {
    id: 'fal-image',
    label: 'fal.ai 图片',
    kind: 'image',
    baseUrl: 'https://fal.run',
    protocol: 'native',
    description: '预留：fal.ai 图片模型。',
  },
  {
    id: 'together-image',
    label: 'Together 图片',
    kind: 'image',
    baseUrl: 'https://api.together.xyz/v1',
    protocol: 'native',
    description: '预留：Together 图片模型。',
  },
  {
    id: 'minimax-image',
    label: 'MiniMax 图片',
    kind: 'image',
    baseUrl: 'https://api.minimax.io/v1',
    protocol: 'native',
    description: '预留：MiniMax 图片生成。',
  },
  {
    id: 'dashscope-wanx',
    label: '通义万相',
    kind: 'image',
    baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
    protocol: 'native',
    description: '预留：阿里云通义万相图片生成。',
  },
  {
    id: 'volcengine-image',
    label: '火山 Seedream',
    kind: 'image',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    protocol: 'native',
    description: '预留：火山引擎 Seedream 图片生成。',
  },
  {
    id: 'zhipu-cogview',
    label: '智谱 CogView',
    kind: 'image',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    protocol: 'native',
    description: '预留：智谱 CogView 图片生成。',
  },
  {
    id: 'ideogram',
    label: 'Ideogram',
    kind: 'image',
    baseUrl: 'https://api.ideogram.ai',
    protocol: 'native',
    description: '预留：Ideogram 图片生成。',
  },
  {
    id: 'recraft',
    label: 'Recraft',
    kind: 'image',
    baseUrl: 'https://external.api.recraft.ai/v1',
    protocol: 'native',
    description: '预留：Recraft 图片生成。',
  },
  {
    id: 'leonardo',
    label: 'Leonardo AI',
    kind: 'image',
    baseUrl: 'https://cloud.leonardo.ai/api/rest/v1',
    protocol: 'native',
    description: '预留：Leonardo AI 图片生成。',
  },
  {
    id: 'firefly',
    label: 'Adobe Firefly',
    kind: 'image',
    baseUrl: 'https://firefly-api.adobe.io/v3',
    protocol: 'native',
    description: '预留：Adobe Firefly 图片生成。',
  },
  {
    id: 'runway',
    label: 'Runway',
    kind: 'video',
    baseUrl: 'https://api.dev.runwayml.com/v1',
    protocol: 'native',
    description: '预留：Runway 视频生成接口。',
  },
  {
    id: 'minimax-video',
    label: 'MiniMax 海螺',
    kind: 'video',
    baseUrl: 'https://api.minimax.io/v1',
    protocol: 'native',
    description: '预留：MiniMax 海螺视频生成。',
  },
  {
    id: 'google-veo',
    label: 'Google Veo',
    kind: 'video',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    protocol: 'native',
    description: '预留：Google Veo 视频生成。',
  },
  {
    id: 'luma',
    label: 'Luma Dream Machine',
    kind: 'video',
    baseUrl: 'https://api.lumalabs.ai/dream-machine/v1',
    protocol: 'native',
    description: '预留：Luma Dream Machine。',
  },
  {
    id: 'kling',
    label: '可灵 Kling',
    kind: 'video',
    baseUrl: 'https://api.klingai.com/v1',
    protocol: 'native',
    description: '预留：快手可灵视频生成。',
  },
  {
    id: 'openai-video',
    label: 'OpenAI 视频',
    kind: 'video',
    baseUrl: 'https://api.openai.com/v1',
    protocol: 'native',
    description: '预留：OpenAI 视频接口。',
  },
  {
    id: 'volcengine-video',
    label: '火山 Seedance',
    kind: 'video',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    protocol: 'native',
    description: '预留：火山引擎 Seedance 视频生成。',
  },
  {
    id: 'dashscope-video',
    label: '通义万相视频',
    kind: 'video',
    baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
    protocol: 'native',
    description: '预留：通义万相视频生成。',
  },
  {
    id: 'replicate-video',
    label: 'Replicate 视频',
    kind: 'video',
    baseUrl: 'https://api.replicate.com/v1',
    protocol: 'native',
    description: '预留：Replicate 视频模型。',
  },
  {
    id: 'fal-video',
    label: 'fal.ai 视频',
    kind: 'video',
    baseUrl: 'https://fal.run',
    protocol: 'native',
    description: '预留：fal.ai 视频模型。',
  },
  {
    id: 'stability-video',
    label: 'Stability 视频',
    kind: 'video',
    baseUrl: 'https://api.stability.ai',
    protocol: 'native',
    description: '预留：Stability AI 视频生成。',
  },
];

export function vendorOptions(kind: ModelKind): VendorPreset[] {
  return VENDORS.filter((vendor) => vendor.kind === kind);
}

export function findVendor(id: string): VendorPreset | undefined {
  return VENDORS.find((vendor) => vendor.id === id);
}

/** Protocols offered for a category. Vendor integration comes first, code last. */
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
