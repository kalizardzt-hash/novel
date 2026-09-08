import { afterEach, expect, it } from 'vitest';
import { NovelRunner, type RunnerConfig } from '../packages/application/src/runner.ts';
import type { GenerationOptions, LanguageModel, Message } from '../packages/application/src/ports.ts';
import { SqliteStoryStore } from '../packages/infrastructure/src/store.ts';
import { projectInputSchema, runInputSchema } from '../packages/domain/src/index.ts';
const stores: SqliteStoryStore[] = [];
afterEach(() => {
  stores.splice(0).forEach((s) => s.close());
});
const config: RunnerConfig = {
  context: { cap: 16384, output: 2048, margin: 256, limit: 10, rrfK: 60 },
  temperature: 0.8,
  analysisTemperature: 0.2,
  timeoutMs: 3000,
  retries: 0,
  revisionRounds: 0,
  embeddingChunkChars: 1000,
  summaryBatchSize: 8,
};
const prose =
  '沈砚把铜钥匙交给林舟。窗外的雨还没有停，林舟用手帕擦净钥匙，放进外套内袋。他看了一眼钟楼上的灯，转身走进雨里。';
function setup() {
  const store = new SqliteStoryStore(':memory:');
  stores.push(store);
  const p = store.createProject(projectInputSchema.parse({ title: '雨夜', chapterTarget: 200 }));
  const r = store.createRun(p.id, runInputSchema.parse({ kind: 'blueprint' }), 'setup');
  store.claim('owner', 10000);
  store.completeBlueprint(r.id, 'owner', {
    premise: '寻找钥匙',
    theme: '信任',
    ending: '打开门',
    characters: [],
    worldRules: [],
    volumes: [{ number: 1, title: '雨', goal: '寻找', endState: '开门', promises: [] }],
  });
  store.approveRun(r.id, p.revision);
  const v = store.createRun(p.id, runInputSchema.parse({ kind: 'volume' }), 'volume');
  store.claim('owner', 10000);
  store.completeVolume(v.id, 'owner', {
    number: 1,
    title: '雨',
    goal: '寻找',
    endState: '开门',
    characterArcs: [],
    milestones: ['开门'],
    promises: [],
    chapterCount: 3,
    approved: false,
  });
  store.approveRun(v.id, store.getProject(p.id).revision);
  return { store, projectId: p.id };
}
class FixtureModel implements LanguageModel {
  calls: string[] = [];
  hook?: (task: string, options: GenerationOptions) => void;
  truncate = false;
  major = false;
  dismiss = false;
  async info() {
    return {
      id: 'fixture',
      contextLength: 16384,
      path: 'test-only',
      format: 'fixture',
      structured: true,
      reasoningControl: 'untested' as const,
    };
  }
  async countTokens(messages: Message[]) {
    return Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 2);
  }
  async generate(_messages: Message[], options: GenerationOptions) {
    const properties = options.schema?.properties as Record<string, unknown> | undefined;
    const task = properties?.chapters
      ? 'plan'
      : properties?.findings
        ? 'review'
        : properties?.decisions
          ? 'verify_review'
          : properties?.facts
            ? 'extract'
            : 'write';
    this.calls.push(task);
    this.hook?.(task, options);
    options.signal.throwIfAborted();
    let text: string;
    if (task === 'plan')
      text = JSON.stringify({
        chapters: [
          {
            title: '雨夜来信',
            goal: '交接',
            scenes: [
              {
                title: '雨',
                pov: '沈砚',
                cast: ['沈砚', '林舟'],
                location: '屋内',
                storyTime: '夜晚',
                desire: '交钥匙',
                opposition: '怀疑',
                change: '信任',
                reveal: '',
                endState: '林舟持钥匙',
              },
            ],
          },
        ],
      });
    else if (task === 'review')
      text = JSON.stringify({
        findings: this.major
          ? [
              {
                severity: 'major',
                category: '事实',
                quote: '沈砚把铜钥匙交给林舟。',
                explanation: '与给定规则冲突',
                suggestion: '修正',
              },
            ]
          : [],
        strengths: [],
      });
    else if (task === 'verify_review')
      text = JSON.stringify({
        decisions: [
          { index: 0, verdict: this.dismiss ? 'dismissed' : 'upheld', reason: '测试夹具中的证据判断' },
        ],
      });
    else if (task === 'extract')
      text = JSON.stringify({
        summary: '钥匙交给林舟',
        facts: [
          {
            subject: '铜钥匙',
            predicate: '保管人',
            value: '林舟',
            kind: 'state',
            holder: null,
            storyTime: '夜晚',
            quote: '沈砚把铜钥匙交给林舟。',
          },
        ],
      });
    else {
      text = prose;
      options.onText?.(text);
    }
    return {
      text,
      stopReason: this.truncate && task === 'write' ? 'maxPredictedTokensReached' : 'eosFound',
      stats: { fixture: true },
    };
  }
}
it('真实用例与数据库闭环：检查、生成、审校和记忆原子收录', async () => {
  const { store, projectId } = setup();
  const r = store.createRun(projectId, runInputSchema.parse({ kind: 'write' }), 'write');
  store.claim('worker', 60000);
  const model = new FixtureModel();
  await new NovelRunner(store, model, undefined, config).execute(
    r.id,
    'worker',
    new AbortController().signal,
  );
  expect(store.getRun(r.id).status).toBe('completed');
  expect(model.calls).toEqual(['plan', 'write', 'review', 'extract']);
  expect(store.facts(projectId)[0]?.value).toBe('林舟');
  expect(store.chapters(projectId)[0]?.status).toBe('accepted');
});
it('在场景检查点暂停后恢复，不重复生成已完成场景', async () => {
  const { store, projectId } = setup();
  const r = store.createRun(projectId, runInputSchema.parse({ kind: 'write' }), 'write');
  store.claim('worker', 60000);
  const model = new FixtureModel();
  model.hook = (task) => {
    if (task === 'write') store.controlRun(r.id, 'pause');
  };
  const runner = new NovelRunner(store, model, undefined, config);
  await runner.execute(r.id, 'worker', new AbortController().signal);
  expect(store.getRun(r.id).status).toBe('paused');
  expect(store.getRun(r.id).checkpoint.text).toBe(prose);
  expect(store.chapters(projectId)).toHaveLength(0);
  model.hook = undefined;
  store.controlRun(r.id, 'resume');
  store.claim('worker', 60000);
  await runner.execute(r.id, 'worker', new AbortController().signal);
  expect(store.getRun(r.id).status).toBe('completed');
  expect(model.calls.filter((c) => c === 'write')).toHaveLength(1);
});
it('输出截断不提交小说，保留中断预览', async () => {
  const { store, projectId } = setup();
  const r = store.createRun(projectId, runInputSchema.parse({ kind: 'write' }), 'write');
  store.claim('worker', 60000);
  const m = new FixtureModel();
  m.truncate = true;
  await new NovelRunner(store, m, undefined, config).execute(r.id, 'worker', new AbortController().signal);
  expect(store.getRun(r.id).status).toBe('failed');
  expect(store.chapters(projectId)).toHaveLength(0);
  expect(store.events(projectId).some((e) => e.type === 'generation.interrupted')).toBe(true);
});
it('重大质量问题阻止收录且保留草稿和审校结果', async () => {
  const { store, projectId } = setup();
  const r = store.createRun(projectId, runInputSchema.parse({ kind: 'write' }), 'write');
  store.claim('worker', 60000);
  const m = new FixtureModel();
  m.major = true;
  await new NovelRunner(store, m, undefined, config).execute(r.id, 'worker', new AbortController().signal);
  expect(store.getRun(r.id).status).toBe('failed');
  expect(store.getRun(r.id).checkpoint.text).toBe(prose);
  expect(store.facts(projectId)).toHaveLength(0);
});
it('生成期间的作者编辑不会被旧任务覆盖', async () => {
  const { store, projectId } = setup();
  const r = store.createRun(projectId, runInputSchema.parse({ kind: 'write' }), 'write');
  store.claim('worker', 60000);
  const m = new FixtureModel();
  m.hook = (task) => {
    if (task === 'write') {
      const p = store.getProject(projectId);
      store.updateProject(projectId, { ...p, title: '作者刚改的书名' }, p.revision);
    }
  };
  await new NovelRunner(store, m, undefined, config).execute(r.id, 'worker', new AbortController().signal);
  expect(store.getProject(projectId).title).toBe('作者刚改的书名');
  expect(store.getRun(r.id).status).toBe('failed');
  expect(store.chapters(projectId)).toHaveLength(0);
});

it('缺乏支持的审校意见保留复核记录，不触发整章重写', async () => {
  const { store, projectId } = setup();
  const r = store.createRun(projectId, runInputSchema.parse({ kind: 'write' }), 'verified-review');
  store.claim('worker', 60000);
  const model = new FixtureModel();
  model.major = true;
  model.dismiss = true;
  await new NovelRunner(store, model, undefined, config).execute(
    r.id,
    'worker',
    new AbortController().signal,
  );
  expect(store.getRun(r.id).status).toBe('completed');
  expect(store.chapters(projectId)[0]?.text).toBe(prose);
  expect(store.events(projectId).some((e) => e.type === 'review.verified')).toBe(true);
});
it('导入稿按章节顺序收录，记忆源版本与批次进度一致', async () => {
  const { store, projectId } = setup();
  for (const title of ['来信', '钥匙'])
    store.saveChapter(projectId, { title, text: prose, volume: 1 }, store.getProject(projectId).revision);
  const r = store.createRun(projectId, runInputSchema.parse({ kind: 'ingest', count: 2 }), 'ingest');
  store.claim('worker', 60000);
  await new NovelRunner(store, new FixtureModel(), undefined, config).execute(
    r.id,
    'worker',
    new AbortController().signal,
  );
  expect(store.getRun(r.id).status).toBe('completed');
  expect(store.getRun(r.id).progress).toBe(2);
  expect(store.chapters(projectId).map((c) => c.status)).toEqual(['accepted', 'accepted']);
  expect(store.facts(projectId).map((f) => f.chapterNumber)).toEqual([1, 2]);
});
