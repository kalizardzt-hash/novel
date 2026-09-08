import { DomainError } from '../../domain/src/index.ts';
import type {
  Embeddings,
  GenerationOptions,
  GenerationResult,
  LanguageModel,
  Message,
  ModelInfo,
} from '../../application/src/ports.ts';
import type { ModelSettings } from '../../application/src/settings.ts';

/**
 * OpenAI 兼容 HTTP 适配器。任何实现 /v1/chat/completions、/v1/embeddings、
 * /v1/models 的服务（LM Studio、Ollama、vLLM、DeepSeek、OpenAI 等）都可接入，
 * 应用层端口不感知具体提供商。
 */
type ChatCompletionChunk = {
  choices?: { delta?: { content?: string; reasoning_content?: string }; finish_reason?: string | null }[];
  usage?: Record<string, unknown>;
};
export class OpenAICompatibleModel implements LanguageModel {
  constructor(private config: ModelSettings) {}
  private endpoint(path: string) {
    return this.config.baseUrl.replace(/\/+$/, '') + path;
  }
  private headers() {
    return {
      'Content-Type': 'application/json',
      ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
    };
  }
  /** 列出服务当前提供的模型。 */
  async listModels(signal?: AbortSignal): Promise<{ id: string }[]> {
    const response = await this.fetchOrThrow('/models', 'GET', undefined, signal);
    const body = (await response.json()) as { data?: { id?: string }[] };
    return (body.data ?? [])
      .map((m) => ({ id: String(m.id ?? '') }))
      .filter((m) => m.id.length > 0);
  }
  /** 空标识只在恰好有一个可用模型时自动选择，保持既有的保守行为。 */
  private async modelId(signal?: AbortSignal): Promise<string> {
    if (this.config.identifier) return this.config.identifier;
    const models = await this.listModels(signal);
    if (models.length === 1) return models[0]!.id;
    throw new DomainError(
      'MODEL_NOT_LOADED',
      models.length
        ? '服务上有多个模型，请在设置中选择主模型标识'
        : '模型服务上没有可用模型；请加载模型或检查 API 地址',
      503,
    );
  }
  async info(signal?: AbortSignal): Promise<ModelInfo> {
    return {
      id: await this.modelId(signal),
      // OpenAI 兼容接口不报告模型上下文长度，以用户配置的保守上限为准。
      contextLength: this.config.contextCap,
      structured: this.config.responseFormat !== 'prompt',
      reasoningControl: 'untested',
    };
  }
  async countTokens(messages: Message[]): Promise<number> {
    return messages.reduce((n, m) => n + estimateTokens(m.content), 0);
  }
  async generate(messages: Message[], options: GenerationOptions): Promise<GenerationResult> {
    const model = await this.modelId(options.signal);
    const started = performance.now();
    const body: Record<string, unknown> = {
      model,
      messages,
      temperature: options.temperature,
      max_tokens: options.maxTokens,
      stream: true,
    };
    if (options.schema && this.config.responseFormat === 'json_object')
      body.response_format = { type: 'json_object' };
    if (options.schema && this.config.responseFormat === 'json_schema')
      body.response_format = {
        type: 'json_schema',
        json_schema: { name: 'output', schema: options.schema },
      };
    const response = await this.fetchOrThrow('/chat/completions', 'POST', body, options.signal);
    const contentType = response.headers.get('content-type') ?? '';
    // 流式通道边收边过滤，供预览；最终文本用独立过滤器重放，两者结果一致。
    const live = new ReasoningFilter();
    let content = '';
    let stopReason = 'stop';
    const absorb = (piece: string) => {
      content += piece;
      const text = live.push(piece);
      if (text) options.onText?.(text);
    };
    if (contentType.includes('application/json')) {
      // 个别服务会忽略 stream 参数，直接返回完整 JSON。
      const completion = (await response.json()) as {
        choices?: { message?: { content?: string }; finish_reason?: string | null }[];
      };
      if (completion.choices?.[0]?.message?.content) absorb(completion.choices[0].message.content);
      stopReason = completion.choices?.[0]?.finish_reason ?? 'stop';
    } else {
      let buffer = '';
      const decoder = new TextDecoder();
      for await (const chunk of response.body!) {
        buffer = (buffer + decoder.decode(chunk as Uint8Array, { stream: true })).replaceAll('\r\n', '\n');
        let separator = buffer.indexOf('\n\n');
        while (separator >= 0) {
          const event = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);
          for (const delta of parseStreamEvent(event)) {
            if (delta.choices?.[0]?.delta?.content) absorb(delta.choices[0]!.delta!.content!);
            if (delta.choices?.[0]?.finish_reason) stopReason = delta.choices[0]!.finish_reason!;
          }
          separator = buffer.indexOf('\n\n');
        }
      }
      for (const delta of parseStreamEvent(buffer + decoder.decode()))
        if (delta.choices?.[0]?.delta?.content) absorb(delta.choices[0]!.delta!.content!);
    }
    const tail = live.flush();
    if (tail) options.onText?.(tail);
    const final = new ReasoningFilter();
    return {
      text: (final.push(content) + final.flush()).trim(),
      stopReason,
      stats: {
        model,
        stopReason,
        elapsedMs: performance.now() - started,
        reasoningRequested: this.config.reasoning,
      },
    };
  }
  private async fetchOrThrow(
    path: string,
    method: 'GET' | 'POST',
    body: unknown,
    signal?: AbortSignal,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(this.endpoint(path), {
        method,
        headers: this.headers(),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: signal ?? AbortSignal.timeout(30000),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new DomainError(
        'MODEL_REQUEST_FAILED',
        `无法连接模型服务 ${this.config.baseUrl}：${error instanceof Error ? error.message : String(error)}`,
        502,
      );
    }
    if (response.ok) return response;
    const detail = await response
      .json()
      .then((data) => {
        const e = data as { error?: { message?: string }; message?: string };
        return e.error?.message ?? e.message ?? '';
      })
      .catch(() => '');
    const message = detail || `模型服务返回 ${response.status}`;
    // 配置类错误（鉴权、模型不存在、请求非法）不重试；限流与服务端错误交给上层重试。
    if (response.status === 429 || response.status >= 500)
      throw new DomainError('MODEL_REQUEST_FAILED', message, 502);
    throw new DomainError('MODEL_CONFIG_INVALID', message, 400);
  }
}

/** 解析一段 SSE 事件中的 data 行；忽略注释与 [DONE]。 */
function parseStreamEvent(event: string): ChatCompletionChunk[] {
  const chunks: ChatCompletionChunk[] = [];
  for (const line of event.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const data = line.replace(/^data:\s?/, '').trim();
    if (!data || data === '[DONE]') continue;
    try {
      chunks.push(JSON.parse(data) as ChatCompletionChunk);
    } catch {
      // 跳过无法解析的行，保留已收到的内容。
    }
  }
  return chunks;
}

/** 无 Token 接口时的保守估算：中日韩字符约 1 token，其余约 3 字符 1 token。 */
export function estimateTokens(text: string): number {
  const cjk =
    text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)?.length ??
    0;
  return cjk + Math.ceil((text.length - cjk) / 3);
}

/** Holds partial delimiters so a split thinking tag never leaks to the manuscript. */
export class ReasoningFilter {
  private buffer = '';
  private thinking = false;
  push(chunk: string): string {
    this.buffer += chunk;
    let out = '';
    while (this.buffer.length) {
      const marker = this.thinking ? '</think>' : '<think>';
      const index = this.buffer.indexOf(marker);
      if (index >= 0) {
        if (!this.thinking) out += this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + marker.length);
        this.thinking = !this.thinking;
        continue;
      }
      let reserve = 0;
      for (let n = 1; n < marker.length; n++) if (this.buffer.endsWith(marker.slice(0, n))) reserve = n;
      const safe = this.buffer.slice(0, this.buffer.length - reserve);
      if (!this.thinking) out += safe;
      this.buffer = this.buffer.slice(this.buffer.length - reserve);
      break;
    }
    return out;
  }
  flush(): string {
    const text = this.thinking || this.buffer.startsWith('<') ? '' : this.buffer;
    this.buffer = '';
    return text;
  }
}

export class OpenAICompatibleEmbeddings implements Embeddings {
  constructor(
    private settings: { baseUrl: string; apiKey: string; identifier: string; enabled: boolean },
  ) {}
  /** 向量身份包含服务地址、模型与查询包装方式；任一变化都会触发重建索引。 */
  async identity() {
    if (!this.settings.enabled || !this.settings.identifier)
      throw new DomainError('EMBEDDING_UNAVAILABLE', '未启用 Embedding；使用结构化与全文检索');
    return `${this.settings.baseUrl}|${this.settings.identifier}|${this.queryWrapper}|normalized-full-dimension`;
  }
  private get queryWrapper() {
    // Qwen3 Embedding 系列要求检索查询带指令前缀；其他模型原样传入。
    return /qwen/i.test(this.settings.identifier) ? 'qwen-query-v1' : 'raw-query-v1';
  }
  async embed(text: string, query = false) {
    await this.identity();
    const input =
      query && this.queryWrapper === 'qwen-query-v1'
        ? `Instruct: Retrieve passages from the novel that establish the characters, events, knowledge, and continuity relevant to this writing task.\nQuery: ${text}`
        : text;
    let response: Response;
    try {
      response = await fetch(this.settings.baseUrl.replace(/\/+$/, '') + '/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.settings.apiKey ? { Authorization: `Bearer ${this.settings.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: this.settings.identifier, input }),
        signal: AbortSignal.timeout(60000),
      });
    } catch (error) {
      throw new DomainError(
        'MODEL_REQUEST_FAILED',
        `无法连接 Embedding 服务：${error instanceof Error ? error.message : String(error)}`,
        502,
      );
    }
    if (!response.ok) {
      const detail = await response
        .json()
        .then((data) => (data as { error?: { message?: string }; message?: string }).error?.message)
        .catch(() => '');
      throw new DomainError('INVALID_EMBEDDING', detail || `Embedding 服务返回 ${response.status}`, 502);
    }
    const body = (await response.json()) as { data?: { embedding?: number[] }[] };
    const embedding = body.data?.[0]?.embedding;
    if (!Array.isArray(embedding) || !embedding.length)
      throw new DomainError('INVALID_EMBEDDING', 'Embedding 返回了无效向量');
    let norm = 0;
    for (const value of embedding) {
      if (!Number.isFinite(value)) throw new DomainError('INVALID_EMBEDDING', 'Embedding 返回了无效向量');
      norm += value * value;
    }
    norm = Math.sqrt(norm);
    if (!norm) throw new DomainError('INVALID_EMBEDDING', 'Embedding 返回了无效向量');
    return embedding.map((value) => value / norm);
  }
}
