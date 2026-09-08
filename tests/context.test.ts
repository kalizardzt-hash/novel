import { expect, it } from 'vitest';
import { buildContext } from '../packages/application/src/context.ts';
import {
  countChars,
  deterministicReview,
  projectInputSchema,
  verifyFacts,
  type Evidence,
  type Project,
} from '../packages/domain/src/index.ts';
import type { LanguageModel } from '../packages/application/src/ports.ts';
import { ReasoningFilter } from '../packages/infrastructure/src/openai.ts';
const project: Project = {
  ...projectInputSchema.parse({ title: '测试' }),
  id: 'p',
  revision: 1,
  outline: null,
  approved: false,
  volumes: {},
  createdAt: '',
  updatedAt: '',
};
const model: LanguageModel = {
  info: async () => ({
    id: 'test',
    contextLength: 2048,
    path: 'test',
    format: 'test',
    structured: true,
    reasoningControl: 'untested',
  }),
  countTokens: async (m) => m.reduce((n, x) => n + x.content.length, 0),
  generate: async () => {
    throw new Error('not used');
  },
};
it('上下文预算包含正文输出余量，低相关证据被排除且记录原因', async () => {
  const evidence: Evidence[] = [
    { id: 'big', title: '远期信息', revision: 1, source: 'chapter', text: '甲'.repeat(2000), score: 1 },
  ];
  const result = await buildContext(model, project, 'intent', '查资料', evidence, '', {
    cap: 2048,
    output: 512,
    margin: 100,
    limit: 10,
    rrfK: 60,
  });
  expect(result.manifest.omitted).toEqual(['big']);
  expect(result.manifest.inputTokens + result.manifest.outputTokens + 100).toBeLessThanOrEqual(2048);
});
it('关键设定超预算时明确阻止，不能静默截断', async () => {
  await expect(
    buildContext(model, project, 'write', '续写', [], '规则'.repeat(3000), {
      cap: 2048,
      output: 512,
      margin: 100,
      limit: 10,
      rrfK: 60,
    }),
  ).rejects.toThrow('关键资料');
});
it('思考标签跨分片仍不会进入正文', () => {
  const f = new ReasoningFilter();
  const output =
    ['<th', 'ink>内部', '分析</thi', 'nk>沈砚', '走进屋内。'].map((s) => f.push(s)).join('') + f.flush();
  expect(output).toBe('沈砚走进屋内。');
});
it('未闭合思考区被丢弃', () => {
  const f = new ReasoningFilter();
  expect(f.push('<think>只有分析') + f.flush()).toBe('');
});
it('词数与中文汉字按 Unicode 计算，标点、标题外部处理', () => {
  expect(countChars('沈砚，走了。 A1 😊𠮷')).toBe(7);
});
it('信念缺失持有人不能升格为记忆', () => {
  expect(() =>
    verifyFacts('沈砚相信门已开。', [
      {
        subject: '门',
        predicate: '状态',
        value: '开',
        kind: 'belief',
        holder: null,
        storyTime: '',
        quote: '沈砚相信门已开。',
      },
    ]),
  ).toThrow('持有人');
});
it('重复段落与思考污染能阻止自动收录', () => {
  const paragraph =
    '林舟沿着旧河堤走了很久，鞋底的泥水洇入袜子，远处灯火亮起，他终于停下，掏出那封一直没拆开的信。';
  expect(deterministicReview(paragraph + '\n\n' + paragraph).some((f) => f.severity === 'major')).toBe(true);
  expect(deterministicReview('<think>分析</think>正文')[0]?.severity).toBe('blocker');
});

it('定点修订只修改唯一锚点，拒绝模糊或重叠修改', async () => {
  const { applyTextEdits } = await import('../packages/domain/src/index.ts');
  expect(applyTextEdits('他拿起纸张。雨还在下。', [{ quote: '纸张', replacement: '信纸' }])).toBe(
    '他拿起信纸。雨还在下。',
  );
  expect(() => applyTextEdits('雨声。雨声。', [{ quote: '雨声', replacement: '风声' }])).toThrow('唯一');
  expect(() =>
    applyTextEdits('他拿起纸张。', [
      { quote: '拿起纸张', replacement: '放下' },
      { quote: '纸张', replacement: '铜钥匙' },
    ]),
  ).toThrow('重叠');
});

it('写作投影隐藏作者秘密，明确公开的字段保留；规划仍有完整设定', async () => {
  const { projectEntity } = await import('../packages/domain/src/templates.ts');
  const { entityInputSchema } = await import('../packages/domain/src/index.ts');
  const entity = {
    ...entityInputSchema.parse({
      name: '林舟',
      kind: 'character',
      fields: { 秘密: '名册曾被调走', 说话方式: '谨慎', 身世: '隐藏身世' },
      fieldVisibility: { 身世: 'author' },
    }),
    id: 'lin',
    projectId: 'p',
    revision: 1,
    createdAt: '',
    updatedAt: '',
  };
  expect(projectEntity(entity, true).fields).toEqual({ 说话方式: '谨慎' });
  expect(projectEntity(entity, false).fields.秘密).toBe('名册曾被调走');
  expect(projectEntity({ ...entity, fieldVisibility: { 秘密: 'public' } }, true).fields.秘密).toBe(
    '名册曾被调走',
  );
});

it('取消可以结束没有原生取消接口的上下文读取等待', async () => {
  const { withSignal } = await import('../packages/application/src/cancellation.ts');
  const controller = new AbortController();
  const waiting = withSignal(new Promise<never>(() => {}), controller.signal);
  controller.abort(new Error('作者取消'));
  await expect(waiting).rejects.toThrow('作者取消');
});
