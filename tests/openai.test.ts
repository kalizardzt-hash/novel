import { afterEach, expect, it, vi } from 'vitest';
import {
  OpenAICompatibleEmbeddings,
  OpenAICompatibleModel,
  estimateTokens,
} from '../packages/infrastructure/src/openai.ts';
import { DomainError, stripJsonFence } from '../packages/domain/src/index.ts';
import { modelSettingsSchema, normalizeBaseUrl } from '../packages/application/src/settings.ts';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});
const settings = (overrides: Record<string, unknown> = {}) =>
  modelSettingsSchema.parse({ identifier: 'test-model', baseUrl: 'http://127.0.0.1:1234/v1', ...overrides });
function sseResponse(chunks: string[], status = 200) {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { 'content-type': 'text/event-stream' } });
}
const delta = (content?: string, finish_reason?: string | null) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: finish_reason ?? null }] })}\n\n`;
const DONE = 'data: [DONE]\n\n';

it('估算 token：中文约一字一位，英文约三字符一位', () => {
  expect(estimateTokens('沈砚拿走铜钥匙')).toBe(7);
  expect(estimateTokens('abcdefgh')).toBe(3);
  expect(estimateTokens('沈砚 ab')).toBe(3);
});

it('剥离 JSON 输出的代码围栏与前后噪声', () => {
  expect(stripJsonFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
  expect(stripJsonFence('```\n{"a":1}\n```')).toBe('{"a":1}');
  expect(stripJsonFence('好的，结果如下：\n{"a":1}')).toBe('{"a":1}');
  expect(stripJsonFence('{"a":1}')).toBe('{"a":1}');
});

it('历史 LM Studio WebSocket 地址迁移为 OpenAI 兼容地址', () => {
  expect(normalizeBaseUrl('ws://127.0.0.1:1234')).toBe('http://127.0.0.1:1234/v1');
  expect(normalizeBaseUrl('http://127.0.0.1:1234')).toBe('http://127.0.0.1:1234/v1');
  expect(normalizeBaseUrl('http://127.0.0.1:1234/v1')).toBe('http://127.0.0.1:1234/v1');
  expect(normalizeBaseUrl('https://api.deepseek.com/v1/')).toBe('https://api.deepseek.com/v1/');
  expect(normalizeBaseUrl('https://example.com/openai/deployments/gpt')).toBe(
    'https://example.com/openai/deployments/gpt',
  );
});

it('流式补全：跨分片思考标签被过滤，finish_reason 正确映射', async () => {
  globalThis.fetch = vi.fn(async () =>
    sseResponse([
      delta('沈砚'),
      delta('<th'),
      delta('ink>分析</thi'),
      delta('nk>拿起'),
      delta('铜钥匙。'),
      delta(undefined, 'stop'),
      DONE,
    ]),
  );
  const model = new OpenAICompatibleModel(settings());
  const seen: string[] = [];
  const result = await model.generate([{ role: 'user', content: '写一句' }], {
    maxTokens: 100,
    temperature: 0.5,
    signal: new AbortController().signal,
    onText: (t) => seen.push(t),
  });
  expect(result.text).toBe('沈砚拿起铜钥匙。');
  expect(result.stopReason).toBe('stop');
  expect(seen.join('')).toBe('沈砚拿起铜钥匙。');
  const request = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
  expect(request[0]).toBe('http://127.0.0.1:1234/v1/chat/completions');
  const body = JSON.parse(String(request[1]!.body));
  expect(body.model).toBe('test-model');
  expect(body.stream).toBe(true);
  expect(body.max_tokens).toBe(100);
});

it('截断输出映射为 length，结构化请求带 JSON 模式并使用分析参数', async () => {
  globalThis.fetch = vi.fn(async () => sseResponse([delta('{"a":', undefined), delta(undefined, 'length'), DONE]));
  const model = new OpenAICompatibleModel(settings());
  const result = await model.generate([{ role: 'user', content: '输出 JSON' }], {
    maxTokens: 100,
    temperature: 0.5,
    signal: new AbortController().signal,
    schema: { type: 'object', properties: { a: { type: 'number' } } },
  });
  expect(result.stopReason).toBe('length');
  const body = JSON.parse(String((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1]!.body));
  expect(body.response_format).toEqual({ type: 'json_object' });
});

it('CRLF 分隔的 SSE 事件也能解析', async () => {
  globalThis.fetch = vi.fn(async () =>
    sseResponse([delta('第一段').replaceAll('\n', '\r\n'), delta('第二段').replaceAll('\n', '\r\n'), DONE]),
  );
  const model = new OpenAICompatibleModel(settings());
  const result = await model.generate([{ role: 'user', content: '写' }], {
    maxTokens: 100,
    temperature: 0.5,
    signal: new AbortController().signal,
  });
  expect(result.text).toBe('第一段第二段');
});

it('服务端忽略 stream 返回完整 JSON 时仍可读取', async () => {
  globalThis.fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '完整回复' }, finish_reason: 'stop' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  );
  const model = new OpenAICompatibleModel(settings());
  const result = await model.generate([{ role: 'user', content: '写' }], {
    maxTokens: 100,
    temperature: 0.5,
    signal: new AbortController().signal,
  });
  expect(result.text).toBe('完整回复');
  expect(result.stopReason).toBe('stop');
});

it('空标识在恰好一个模型时自动选择，多个模型时报错', async () => {
  globalThis.fetch = vi.fn(async (url) =>
    new Response(JSON.stringify({ data: [{ id: 'only-model' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
  const auto = new OpenAICompatibleModel(settings({ identifier: '' }));
  expect((await auto.info()).id).toBe('only-model');
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify({ data: [{ id: 'a' }, { id: 'b' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
  const ambiguous = new OpenAICompatibleModel(settings({ identifier: '' }));
  await expect(ambiguous.info()).rejects.toThrow('多个模型');
});

it('配置类错误不重试抛出，服务端错误映射为可重试错误', async () => {
  globalThis.fetch = vi.fn(
    async () =>
      new Response(JSON.stringify({ error: { message: 'Incorrect API key' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
  );
  const model = new OpenAICompatibleModel(settings());
  const failure = model.generate([{ role: 'user', content: 'x' }], {
    maxTokens: 10,
    temperature: 0,
    signal: new AbortController().signal,
  });
  await expect(failure).rejects.toMatchObject({ code: 'MODEL_CONFIG_INVALID' });
  await expect(failure).rejects.toThrow('Incorrect API key');
  globalThis.fetch = vi.fn(
    async () =>
      new Response(JSON.stringify({ error: { message: 'server busy' } }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      }),
  );
  await expect(
    model.generate([{ role: 'user', content: 'x' }], {
      maxTokens: 10,
      temperature: 0,
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({ code: 'MODEL_REQUEST_FAILED' });
});

it('连接失败映射为模型请求失败；取消信号原样传播', async () => {
  globalThis.fetch = vi.fn(async () => {
    throw new TypeError('fetch failed');
  });
  const model = new OpenAICompatibleModel(settings());
  await expect(
    model.generate([{ role: 'user', content: 'x' }], {
      maxTokens: 10,
      temperature: 0,
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({ code: 'MODEL_REQUEST_FAILED' });
  const controller = new AbortController();
  controller.abort(new Error('用户取消'));
  globalThis.fetch = vi.fn(async () => {
    throw new Error('aborted');
  });
  // 已取消的信号抛出的原始错误不会被包装成 MODEL_REQUEST_FAILED。
  const raw = model.generate([{ role: 'user', content: 'x' }], {
    maxTokens: 10,
    temperature: 0,
    signal: controller.signal,
  });
  await expect(raw).rejects.toThrow('aborted');
  await expect(raw).rejects.not.toBeInstanceOf(DomainError);
});

it('Embedding 归一化并按模型身份隔离；qwen 查询带指令前缀', async () => {
  const calls: unknown[] = [];
  globalThis.fetch = vi.fn(async (_url, init) => {
    calls.push(JSON.parse(String(init!.body)));
    return new Response(JSON.stringify({ data: [{ embedding: [3, 4] }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  const embeddings = new OpenAICompatibleEmbeddings({
    baseUrl: 'http://127.0.0.1:1234/v1',
    apiKey: '',
    identifier: 'qwen3-embedding',
    enabled: true,
  });
  expect(await embeddings.embed('谁保管钥匙？', true)).toEqual([0.6, 0.8]);
  expect((calls[0] as { input: string }).input).toContain('Instruct:');
  expect(await embeddings.embed('正文段落')).toEqual([0.6, 0.8]);
  expect((calls[1] as { input: string }).input).toBe('正文段落');
  expect(await embeddings.identity()).toContain('qwen-query-v1');
  const other = new OpenAICompatibleEmbeddings({
    baseUrl: 'http://127.0.0.1:1234/v1',
    apiKey: '',
    identifier: 'text-embedding-3-small',
    enabled: true,
  });
  expect(await other.identity()).toContain('raw-query-v1');
  expect((await other.embed('问题', true)) && (calls[2] as { input: string }).input).toBe('问题');
});

it('无效或缺失的 Embedding 向量明确报错', async () => {
  globalThis.fetch = vi.fn(async () => new Response('{"data":[{"embedding":[0,0]}]}'));
  const embeddings = new OpenAICompatibleEmbeddings({
    baseUrl: 'http://127.0.0.1:1234/v1',
    apiKey: '',
    identifier: 'emb',
    enabled: true,
  });
  await expect(embeddings.embed('x')).rejects.toBeInstanceOf(DomainError);
  globalThis.fetch = vi.fn(async () => new Response('not json', { status: 500 }));
  await expect(embeddings.embed('x')).rejects.toMatchObject({ code: 'INVALID_EMBEDDING' });
});
