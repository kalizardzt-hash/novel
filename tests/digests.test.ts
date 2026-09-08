import { afterEach, expect, it } from 'vitest';
import { DigestBuilder } from '../packages/application/src/digests.ts';
import { SqliteStoryStore } from '../packages/infrastructure/src/store.ts';
import { projectInputSchema, runInputSchema } from '../packages/domain/src/index.ts';
const stores: SqliteStoryStore[] = [];
afterEach(() => stores.splice(0).forEach((s) => s.close()));
function fixture() {
  const store = new SqliteStoryStore(':memory:');
  stores.push(store);
  const p = store.createProject(projectInputSchema.parse({ title: '层级测试' }));
  for (let i = 1; i <= 9; i++) {
    const r = store.createRun(
      p.id,
      runInputSchema.parse({ kind: 'write', volume: i < 6 ? 1 : 2 }),
      `chapter-${i}`,
    );
    store.claim('owner', 30000);
    store.commitGenerated(
      r.id,
      'owner',
      store.getProject(p.id).revision,
      `第${i}夜`,
      `第${i}夜，沈砚前往钟楼。`,
      { findings: [], strengths: [] },
      [],
      `第${i}夜沈砚前往钟楼。`,
    );
    store.patchRun(r.id, 'owner', { status: 'completed' });
  }
  const r = store.createRun(p.id, runInputSchema.parse({ kind: 'summarize' }), 'summary');
  store.claim('owner', 30000);
  return { store, p, r };
}
it('摘要分组有界，完整覆盖所有源版本，恢复时复用已完成节点', async () => {
  const { store, p, r } = fixture();
  const builder = new DigestBuilder(store, 3, 'test-v1');
  let calls = 0;
  const generate = async (input: string) => {
    const value = JSON.parse(input);
    expect(value.sections.length).toBeLessThanOrEqual(3);
    calls++;
    return { summary: '沈砚寻找钟楼档案。', stateChanges: [], openPromises: ['父亲的去向'] };
  };
  const result = await builder.build(r.id, 'owner', generate, () => {});
  expect(result.book.sources).toHaveLength(9);
  expect(new Set(result.book.sources.map((s) => s.chapterId)).size).toBe(9);
  expect(result.volumes).toHaveLength(2);
  const previous = calls;
  await builder.build(r.id, 'owner', generate, () => {});
  expect(calls).toBe(previous);
  const c = store.chapters(p.id)[2]!;
  store.saveChapter(p.id, { ...c, text: '作者修改第三章' }, store.getProject(p.id).revision, c.id);
  expect(store.digests(p.id).find((d) => d.id === result.book.id)?.valid).toBe(false);
  expect(store.chapterDigests(p.id)).toHaveLength(2);
});
it('摘要不能引用其他作品，也不能在作者修改后提交', () => {
  const { store, p, r } = fixture();
  const c = store.chapters(p.id)[0]!;
  const input = {
    key: 'bad',
    scope: 'book' as const,
    volume: 0,
    level: 0,
    sources: [{ chapterId: c.id, revision: c.revision + 1, number: c.number }],
    promptVersion: 'v1',
    summary: '错误',
    stateChanges: [],
    openPromises: [],
  };
  expect(() => store.saveDigest(r.id, 'owner', input)).toThrow('当前正式稿');
  store.updateProject(p.id, { ...p, title: '作者改名' }, store.getProject(p.id).revision);
  expect(() =>
    store.saveDigest(r.id, 'owner', {
      ...input,
      sources: [{ chapterId: c.id, revision: c.revision, number: c.number }],
    }),
  ).toThrow('来源已变化');
});
