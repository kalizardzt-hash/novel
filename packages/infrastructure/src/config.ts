import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { normalizeBaseUrl, configSchema, type AppConfig } from '../../application/src/settings.ts';

export { configSchema } from '../../application/src/settings.ts';
export type { AppConfig } from '../../application/src/settings.ts';

export function dataDirectory(): string {
  return path.resolve(process.env.NOVEL_DATA_DIR ?? path.join(process.cwd(), '.novel'));
}

let cached: { value: AppConfig; mtimeMs: number } | null = null;
const configFile = () => path.join(dataDirectory(), 'config.json');

/** 读取配置；按文件修改时间缓存，避免每个请求都落盘读文件。 */
export function readConfig(): AppConfig {
  const file = configFile();
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    cached = null;
  }
  if (cached && cached.mtimeMs === mtimeMs) return cached.value;
  const raw = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  if (raw?.model?.baseUrl) raw.model.baseUrl = normalizeBaseUrl(raw.model.baseUrl);
  const value = configSchema.parse(raw);
  if (process.env.NOVEL_PORT) {
    const port = Number.parseInt(process.env.NOVEL_PORT, 10);
    if (!Number.isInteger(port) || port < 1024 || port > 65535)
      throw new Error(`NOVEL_PORT 无效：${process.env.NOVEL_PORT}`);
    value.port = port;
  }
  if (process.env.NOVEL_MODEL_API_KEY) value.model.apiKey = process.env.NOVEL_MODEL_API_KEY;
  cached = { value, mtimeMs };
  return value;
}

export function writeConfig(input: unknown): AppConfig {
  const value = configSchema.parse(input);
  value.model.baseUrl = normalizeBaseUrl(value.model.baseUrl);
  new URL(value.model.baseUrl); // 校验最终地址是合法 http(s) URL
  mkdirSync(dataDirectory(), { recursive: true, mode: 0o700 });
  const destination = configFile();
  writeFileSync(destination + '.tmp', JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(destination + '.tmp', destination);
  cached = null;
  return value;
}
