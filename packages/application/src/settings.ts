import { z } from 'zod';

/**
 * 应用层配置契约。只描述策略与预算，不含文件路径或实现细节。
 * 基础设施模块负责读取与持久化；Web 只依赖这里的类型与默认值。
 */
export const responseFormats = ['json_object', 'json_schema', 'prompt'] as const;
export type ResponseFormat = (typeof responseFormats)[number];
export const modelSettingsSchema = z.object({
  /** OpenAI 兼容 API 根地址，含 /v1，例如 http://127.0.0.1:1234/v1 */
  baseUrl: z.string().url().default('http://127.0.0.1:1234/v1'),
  apiKey: z.string().default(''),
  /** 主模型标识；留空时恰好只有一个可用模型会自动选择 */
  identifier: z.string().default(''),
  contextCap: z.number().int().min(2048).max(262144).default(16384),
  outputTokens: z.number().int().min(128).max(16384).default(2048),
  temperature: z.number().min(0).max(2).default(0.8),
  analysisTemperature: z.number().min(0).max(2).default(0.2),
  timeoutMs: z.number().int().min(5000).max(3600000).default(900000),
  marginTokens: z.number().int().min(64).max(4096).default(256),
  reasoning: z.enum(['off', 'default']).default('off'),
  responseFormat: z.enum(responseFormats).default('json_object'),
});
export const embeddingSettingsSchema = z.object({
  identifier: z.string().default(''),
  enabled: z.boolean().default(true),
  chunkChars: z.number().int().min(200).max(4000).default(1000),
});
export const configSchema = z.object({
  host: z.literal('127.0.0.1').default('127.0.0.1'),
  port: z.number().int().min(1024).max(65535).default(4317),
  model: modelSettingsSchema.default({
    baseUrl: 'http://127.0.0.1:1234/v1',
    apiKey: '',
    identifier: '',
    contextCap: 16384,
    outputTokens: 2048,
    temperature: 0.8,
    analysisTemperature: 0.2,
    timeoutMs: 900000,
    marginTokens: 256,
    reasoning: 'off',
    responseFormat: 'json_object',
  }),
  embedding: embeddingSettingsSchema.default({ identifier: '', enabled: true, chunkChars: 1000 }),
  worker: z
    .object({
      pollMs: z.number().int().min(100).default(1000),
      leaseMs: z.number().int().min(5000).default(30000),
      retries: z.number().int().min(0).max(5).default(2),
      revisionRounds: z.number().int().min(0).max(5).default(2),
    })
    .default({ pollMs: 1000, leaseMs: 30000, retries: 2, revisionRounds: 2 }),
  retrieval: z
    .object({ limit: z.number().int().min(5).max(80).default(24), rrfK: z.number().positive().default(60) })
    .default({ limit: 24, rrfK: 60 }),
  memory: z
    .object({ summaryBatchSize: z.number().int().min(2).max(16).default(8) })
    .default({ summaryBatchSize: 8 }),
});
export type AppConfig = z.infer<typeof configSchema>;
export type ModelSettings = z.infer<typeof modelSettingsSchema>;
export type EmbeddingSettings = z.infer<typeof embeddingSettingsSchema>;

/** 兼容历史 LM Studio WebSocket 配置：转为同端口的 HTTP API 地址。 */
export function normalizeBaseUrl(raw: string): string {
  let url = raw.trim();
  if (/^wss?:\/\//i.test(url)) url = url.replace(/^ws/i, 'http');
  if (/^https?:\/\//i.test(url)) {
    const trimmed = url.replace(/\/+$/, '');
    // 旧配置只写主机端口（如 LM Studio ws 地址），迁移到 OpenAI 兼容根路径。
    if (/^https?:\/\/[^/]+$/i.test(trimmed) && !/\/v\d+$/i.test(trimmed)) url = `${trimmed}/v1`;
  }
  return url;
}
