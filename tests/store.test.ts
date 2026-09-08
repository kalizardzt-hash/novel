import { afterEach, describe, expect, it } from 'vitest';
import { SqliteStoryStore } from '../packages/infrastructure/src/store.ts';
import {
  entityInputSchema,
  projectInputSchema,
  runInputSchema,
  type ExtractedFact,
} from '../packages/domain/src/index.ts';
const opened: SqliteStoryStore[] = [];
function setup() {
  const store = new SqliteStoryStore(':memory:');
  opened.push(store);
  const p = store.createProject(projectInputSchema.parse({ title: '铜钥匙' }));
  return { store, p };
}
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});
const fact: ExtractedFact = {
  subject: '沈砚',
  predicate: '持有物',
  value: '铜钥匙',
  kind: 'state',
  holder: null,
  storyTime: '第一夜',
  quote: '沈砚拿走铜钥匙。',
};
function accept(store: SqliteStoryStore, projectId: string, title = '第一夜', text = '沈砚拿走铜钥匙。') {
  const c = store.saveChapter(projectId, { title, text, volume: 1 }, store.getProject(projectId).revision);
  const run = store.createRun(
    projectId,
    runInputSchema.parse({ kind: 'extract', chapterId: c.id }),
    crypto.randomUUID(),
  );
  store.claim('owner', 30000);
  store.commitChapter(
    run.id,
    'owner',
    store.getProject(projectId).revision,
    c.id,
    { findings: [], strengths: [] },
    [fact],
    '钥匙已归沈砚',
  );
  store.patchRun(run.id, 'owner', { status: 'completed' });
  return c;
}
describe('版本、正式记忆与任务持久化', () => {
  it('陈旧写操作不改变原文或项目版本', () => {
    const { store, p } = setup();
    store.updateProject(p.id, { ...p, title: '新名称' }, p.revision);
    expect(() => store.updateProject(p.id, p, p.revision)).toThrow('资料已被修改');
    expect(store.getProject(p.id).title).toBe('新名称');
  });
  it('记忆与章节原子提交，证据不存在时整体回滚', () => {
    const { store, p } = setup();
    const run = store.createRun(p.id, runInputSchema.parse({ kind: 'write' }), 'a');
    store.claim('owner', 30000);
    expect(() =>
      store.commitGenerated(
        run.id,
        'owner',
        p.revision,
        '夜',
        '没有钥匙。',
        { findings: [], strengths: [] },
        [fact],
        '错误',
      ),
    ).toThrow('记忆证据');
    expect(store.chapters(p.id)).toHaveLength(0);
    expect(store.getProject(p.id).revision).toBe(p.revision);
    expect(store.getRun(run.id).progress).toBe(0);
  });
  it('修改前文后，全链后续状态失效且原稿可恢复', () => {
    const { store, p } = setup();
    const c1 = accept(store, p.id);
    const c2 = accept(store, p.id, '第二夜');
    expect(store.facts(p.id)).toHaveLength(2);
    store.saveChapter(
      p.id,
      { title: c1.title, text: '林舟收回铜钥匙。', volume: 1 },
      store.getProject(p.id).revision,
      c1.id,
    );
    expect(store.facts(p.id)).toHaveLength(0);
    expect(store.getChapter(c2.id).status).toBe('stale');
    expect(store.revisions(c1.id)[1]?.text).toBe('沈砚拿走铜钥匙。');
    expect(store.impacts(p.id).length).toBe(2);
  });
  it('相同幂等键只创建一个任务；不同输入不复用结果', () => {
    const { store, p } = setup();
    const input = runInputSchema.parse({ kind: 'write' });
    const first = store.createRun(p.id, input, 'key');
    expect(store.createRun(p.id, input, 'key').id).toBe(first.id);
    expect(() => store.createRun(p.id, runInputSchema.parse({ kind: 'review' }), 'key')).toThrow('幂等键');
    expect(store.runs(p.id)).toHaveLength(1);
  });
  it('全局串行调度、租约过期等待恢复，旧 worker 不能提交', async () => {
    const { store, p } = setup();
    const r = store.createRun(p.id, runInputSchema.parse({ kind: 'write' }), 'one');
    store.createRun(p.id, runInputSchema.parse({ kind: 'write' }), 'two');
    expect(store.claim('first', 10)?.id).toBe(r.id);
    expect(store.claim('second', 1000)).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(store.claim('second', 1000)?.id).not.toBe(r.id);
    expect(store.getRun(r.id).status).toBe('paused');
    expect(() => store.patchRun(r.id, 'first', { status: 'completed' })).toThrow('所有权');
  });
  it('正式提交与任务检查点在同一事务中前进', () => {
    const { store, p } = setup();
    const r = store.createRun(p.id, runInputSchema.parse({ kind: 'write' }), 'one');
    store.claim('owner', 10000);
    const c = store.commitGenerated(
      r.id,
      'owner',
      p.revision,
      '第一夜',
      fact.quote,
      { findings: [], strengths: [] },
      [fact],
      '钥匙已转移',
    );
    expect(store.getRun(r.id).checkpoint.committedChapter).toBe(c.id);
    expect(store.getRun(r.id).progress).toBe(1);
    expect(store.getChapter(c.id).status).toBe('accepted');
    expect(() =>
      store.commitGenerated(
        r.id,
        'owner',
        p.revision,
        '重试',
        fact.quote,
        { findings: [], strengths: [] },
        [fact],
        '',
      ),
    ).toThrow('资料已被修改');
    expect(store.chapters(p.id)).toHaveLength(1);
  });
  it('取消请求阻止正式提交', () => {
    const { store, p } = setup();
    const r = store.createRun(p.id, runInputSchema.parse({ kind: 'write' }), 'c');
    store.claim('owner', 10000);
    store.controlRun(r.id, 'cancel');
    expect(() =>
      store.commitGenerated(
        r.id,
        'owner',
        p.revision,
        '第一夜',
        fact.quote,
        { findings: [], strengths: [] },
        [fact],
        '',
      ),
    ).toThrow('已取消');
    expect(store.chapters(p.id)).toHaveLength(0);
  });
  it('检索隔离作品、未来章节、过期正文和短中文姓名', () => {
    const { store, p } = setup();
    const c = accept(store, p.id);
    const other = store.createProject(projectInputSchema.parse({ title: '另一本' }));
    accept(store, other.id);
    expect(store.search(p.id, '沈砚', 2).map((h) => h.id)).toEqual([c.id]);
    expect(store.search(p.id, '沈砚', 1)).toHaveLength(0);
    store.saveChapter(
      p.id,
      { title: c.title, text: '沈砚改变了计划。', volume: 1 },
      store.getProject(p.id).revision,
      c.id,
    );
    expect(store.search(p.id, '沈砚')).toHaveLength(0);
  });
  it('正式设定修改触发复核；人物知识必须有持有人', () => {
    const { store, p } = setup();
    accept(store, p.id);
    store.saveEntity(
      p.id,
      entityInputSchema.parse({ name: '唯一钥匙', kind: 'rule', fields: { 规则: '只存在一把' } }),
      store.getProject(p.id).revision,
    );
    expect(store.facts(p.id)).toHaveLength(0);
    expect(store.impacts(p.id)).toHaveLength(1);
  });
  it('历史修订不可被普通保存覆盖', () => {
    const { store, p } = setup();
    const c = accept(store, p.id);
    store.saveChapter(
      p.id,
      { title: '改稿', text: '林舟留下铜钥匙。', volume: 1 },
      store.getProject(p.id).revision,
      c.id,
    );
    expect(store.revisions(c.id).map((r) => r.revision)).toEqual([2, 1]);
  });
  it('便携备份恢复正文、历史、关系与有效记忆，且不与原项目共享标识', () => {
    const { store, p } = setup();
    accept(store, p.id);
    const clone = store.importProject(store.exportProject(p.id));
    expect(clone.id).not.toBe(p.id);
    const copied = store.chapters(clone.id)[0]!;
    expect(copied.text).toBe('沈砚拿走铜钥匙。');
    expect(copied.status).toBe('accepted');
    expect(store.facts(clone.id)[0]?.chapterId).toBe(copied.id);
    expect(store.revisions(copied.id)).toHaveLength(1);
    store.saveChapter(
      clone.id,
      { title: '副本修订', text: '换了正文', volume: 1 },
      clone.revision,
      copied.id,
    );
    expect(store.facts(p.id)).toHaveLength(1);
    expect(store.facts(clone.id)).toHaveLength(0);
  });
  it('旧版本规划不能被确认', () => {
    const { store, p } = setup();
    const r = store.createRun(p.id, runInputSchema.parse({ kind: 'blueprint' }), 'p');
    store.claim('owner', 10000);
    store.completeBlueprint(r.id, 'owner', {
      premise: 'p',
      theme: 't',
      ending: 'e',
      volumes: [{ number: 1, title: 'v', goal: 'g', endState: 's', promises: [] }],
      characters: [],
      worldRules: [],
    });
    store.updateProject(p.id, { ...p, title: 'new' }, p.revision);
    expect(() => store.approveRun(r.id, store.getProject(p.id).revision)).toThrow('旧资料');
  });
});

it('批量导入在校验失败时不留下半本书', () => {
  const { store, p } = setup();
  expect(() =>
    store.importChapters(
      p.id,
      [
        { title: '有效章节', text: '正文', volume: 1 },
        { title: '', text: '无效', volume: 1 },
      ],
      p.revision,
    ),
  ).toThrow();
  expect(store.chapters(p.id)).toHaveLength(0);
  expect(store.getProject(p.id).revision).toBe(p.revision);
});
it('批量导入顺序编号为草稿、保留修订与检索索引，并只提升一个版本', () => {
  const { store, p } = setup();
  const first = store.saveChapter(
    p.id,
    { title: '已有章节', text: '原文。', volume: 1 },
    store.getProject(p.id).revision,
  );
  const revisionBefore = store.getProject(p.id).revision;
  const imported = store.importChapters(
    p.id,
    [
      { title: '第一章 雨', text: '下雨了。', volume: 1 },
      { title: '第二章 信', text: '信来了。', volume: 1 },
    ],
    revisionBefore,
  );
  expect(imported.map((c) => c.number)).toEqual([first.number + 1, first.number + 2]);
  expect(imported.map((c) => c.status)).toEqual(['draft', 'draft']);
  expect(store.chapters(p.id).map((c) => c.title)).toEqual(['已有章节', '第一章 雨', '第二章 信']);
  // 一次导入只提升一个项目版本，而不是逐章提升。
  expect(store.getProject(p.id).revision).toBe(revisionBefore + 1);
  for (const c of imported) expect(store.revisions(c.id)).toHaveLength(1);
  // 导入章节标记待复核，与逐章保存行为一致。
  const impacted = new Set(store.impacts(p.id).map((i) => i.chapterId));
  for (const c of imported) expect(impacted.has(c.id)).toBe(true);
});
it('作者可调整待确认方案，但不会隐式采用或改变正式设定', () => {
  const { store, p } = setup();
  const r = store.createRun(p.id, runInputSchema.parse({ kind: 'blueprint' }), 'proposal');
  store.claim('owner', 30000);
  const outline = {
    premise: '寻找',
    theme: '信任',
    ending: '相认',
    volumes: [{ number: 1, title: '雨夜', goal: '寻找', endState: '相认', promises: [] }],
    characters: [],
    worldRules: [],
  };
  store.completeBlueprint(r.id, 'owner', outline);
  store.reviseProposal(r.id, p.revision, { ...outline, ending: '各自离开' });
  expect(store.getRun(r.id).status).toBe('awaiting_approval');
  expect(store.getProject(p.id).outline).toBeNull();
  expect(store.getProject(p.id).revision).toBe(p.revision);
  store.approveRun(r.id, p.revision);
  expect(store.getProject(p.id).outline?.ending).toBe('各自离开');
  expect(() => store.reviseProposal(r.id, p.revision, outline)).toThrow('待确认方案');
});
