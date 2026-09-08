import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { dataDirectory, readConfig } from '../../infrastructure/src/config.ts';
import { OpenAICompatibleModel, OpenAICompatibleEmbeddings } from '../../infrastructure/src/openai.ts';
import { countChars } from '../../domain/src/index.ts';
const config = readConfig();
const model = new OpenAICompatibleModel(config.model);
const report: {
  startedAt: string;
  model?: unknown;
  cases: { name: string; passed: boolean; detail: unknown }[];
} = { startedAt: new Date().toISOString(), cases: [] };
async function check(name: string, test: () => Promise<unknown>) {
  try {
    const detail = await test();
    report.cases.push({ name, passed: true, detail });
    console.log('PASS', name);
  } catch (e) {
    report.cases.push({ name, passed: false, detail: e instanceof Error ? e.message : String(e) });
    console.log('FAIL', name, e instanceof Error ? e.message : e);
  }
}
report.model = await model.info().catch((e) => ({ error: e.message }));
await check('结构化 JSON 与最终输出通道', async () => {
  const schema = z.object({ owner: z.string(), item: z.string() });
  const result = await model.generate(
    [
      {
        role: 'user',
        content: '原文：沈砚把铜钥匙交给林舟。输出 owner（当前持有人）和 item（物品），只用 JSON。',
      },
    ],
    { maxTokens: 256, temperature: 0, signal: AbortSignal.timeout(90000), schema: z.toJSONSchema(schema) },
  );
  const parsed = schema.parse(JSON.parse(result.text));
  if (parsed.owner !== '林舟' || !parsed.item.includes('钥匙')) throw new Error('持有人提取不正确');
  return { result, parsed };
});
await check('中文正文与思考隔离', async () => {
  const result = await model.generate(
    [
      {
        role: 'user',
        content: '写一段100字左右的中文小说正文。沈砚在雨夜等一个没有赴约的人。仅输出正文，不加说明。',
      },
    ],
    { maxTokens: 384, temperature: 0.8, signal: AbortSignal.timeout(120000) },
  );
  if (countChars(result.text) < 50 || /<think>|我们需要|用户要求/.test(result.text))
    throw new Error('正文缺失或受到思考污染');
  return result;
});
await check('人物知识与道具归属冲突', async () => {
  const schema = z.object({ conflict: z.boolean(), reason: z.string() });
  const result = await model.generate(
    [
      {
        role: 'user',
        content:
          '原文：第3章林舟把唯一的铜钥匙交给沈砚。此后没有归还。待审：第5章陆岑从林舟手中接过那把铜钥匙。是否存在道具归属冲突？返回 conflict 和 reason。',
      },
    ],
    { maxTokens: 384, temperature: 0.2, signal: AbortSignal.timeout(120000), schema: z.toJSONSchema(schema) },
  );
  if (!schema.parse(JSON.parse(result.text)).conflict) throw new Error('没有识别冲突');
  return result;
});
await check('取消到真实推理后端', async () => {
  const controller = new AbortController();
  const started = performance.now();
  const timeout = setTimeout(() => controller.abort(), 1500);
  let cancelled = false;
  try {
    const result = await model.generate([{ role: 'user', content: '写一篇两万字的长篇故事。' }], {
      maxTokens: 4000,
      temperature: 0.8,
      signal: controller.signal,
    });
    cancelled = controller.signal.aborted && result.stopReason === 'userStopped';
  } catch {
    cancelled = controller.signal.aborted;
  } finally {
    clearTimeout(timeout);
  }
  if (!cancelled) throw new Error('取消没有中止请求');
  return { elapsedMs: performance.now() - started };
});
await check('中文 Embedding 相关性', async () => {
  const emb = new OpenAICompatibleEmbeddings({
  baseUrl: config.model.baseUrl,
  apiKey: config.model.apiKey,
  identifier: config.embedding.identifier,
  enabled: config.embedding.enabled,
});
  const q = await emb.embed('谁保管那把开门用的钥匙？', true);
  const a = await emb.embed('沈砚把铜钥匙收进自己的口袋。');
  const b = await emb.embed('天气晴朗，远处的山上开满了花。');
  const dot = (v: number[]) => v.reduce((s, n, i) => s + n * q[i]!, 0);
  if (!(dot(a) > dot(b))) throw new Error('相关段落排序错误');
  return {
    identity: await emb.identity(),
    dimensions: q.length,
    relevantScore: dot(a),
    unrelatedScore: dot(b),
  };
});
const directory = path.join(dataDirectory(), 'evaluations');
mkdirSync(directory, { recursive: true });
const file = path.join(directory, `model-${Date.now()}.json`);
writeFileSync(file, JSON.stringify(report, null, 2));
console.log(file);
process.exitCode = report.cases.every((c) => c.passed) ? 0 : 1;
