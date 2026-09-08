/**
 * 模型服务探测与外部提供商预设。探测只访问本机回环地址，
 * 不携带任何 API Key；外部服务仅提供预设地址，由作者自行填 Key。
 */
export interface ProviderPreset {
  name: string;
  baseUrl: string;
  /** 获取 API Key 的入口，仅外部提供商使用。 */
  website?: string;
  /** 探测或选择时的提示。 */
  note?: string;
}

export interface ProbeResult extends ProviderPreset {
  reachable: boolean;
  models: string[];
  /** 不可达时的简短原因，用于界面展示。 */
  detail?: string;
}

/** 常见本机 OpenAI 兼容服务及其默认端口。 */
export const LOCAL_SERVICES: ProviderPreset[] = [
  { name: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1' },
  { name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1' },
  { name: 'llama.cpp / LocalAI', baseUrl: 'http://127.0.0.1:8080/v1' },
  { name: 'vLLM', baseUrl: 'http://127.0.0.1:8000/v1' },
  { name: 'Jan', baseUrl: 'http://127.0.0.1:1337/v1' },
  { name: 'GPT4All', baseUrl: 'http://127.0.0.1:4891/v1' },
  { name: 'KoboldCpp / text-generation-webui', baseUrl: 'http://127.0.0.1:5001/v1' },
];

/** 外部 API 预设；国内服务直连，海外服务按网络环境自行选择。 */
export const EXTERNAL_PROVIDERS: ProviderPreset[] = [
  { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', website: 'https://platform.deepseek.com/api_keys' },
  { name: 'Kimi（月之暗面）', baseUrl: 'https://api.moonshot.cn/v1', website: 'https://platform.moonshot.cn/console/api-keys' },
  {
    name: '通义千问（百炼兼容模式）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    website: 'https://bailian.console.aliyun.com/',
    note: '模型标识形如 qwen-plus、qwen-max',
  },
  { name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', website: 'https://open.bigmodel.cn/usercenter/apikeys' },
  { name: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', website: 'https://cloud.siliconflow.cn/account/ak' },
  {
    name: '火山方舟',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    website: 'https://console.volcengine.com/ark',
    note: '模型标识使用推理接入点 ID',
  },
  { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', website: 'https://platform.openai.com/api-keys' },
  { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', website: 'https://openrouter.ai/keys', note: '一个 Key 聚合多家模型' },
  { name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', website: 'https://console.groq.com/keys' },
];

/** 探测单个服务：GET /models，无 Key、短超时，失败只记录不抛出。 */
async function probeOne(service: ProviderPreset, timeoutMs: number): Promise<ProbeResult> {
  try {
    const response = await fetch(service.baseUrl.replace(/\/+$/, '') + '/models', {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok)
      return { ...service, reachable: false, models: [], detail: `服务返回 ${response.status}` };
    const body = (await response.json()) as { data?: { id?: string }[] };
    const models = (body.data ?? [])
      .map((m) => String(m.id ?? ''))
      .filter((id) => id.length > 0)
      .sort((a, b) => a.localeCompare(b));
    return { ...service, reachable: true, models };
  } catch (error) {
    const detail = error instanceof Error && /timeout|abort/i.test(error.name + error.message)
      ? '响应超时'
      : '未检测到服务';
    return { ...service, reachable: false, models: [], detail };
  }
}

/** 并行探测候选服务；全部失败也不抛错，由界面提示。 */
export async function probeServices(
  candidates: ProviderPreset[],
  timeoutMs = 1500,
): Promise<ProbeResult[]> {
  return Promise.all(candidates.map((service) => probeOne(service, timeoutMs)));
}
