import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SqliteStoryStore } from '../../infrastructure/src/store.ts';
import { dataDirectory } from '../../infrastructure/src/config.ts';
import { projectInputSchema, runInputSchema, countChars } from '../../domain/src/index.ts';
const directory = path.join(dataDirectory(), 'evaluations', `scale-${Date.now()}`);
mkdirSync(directory, { recursive: true });
const store = new SqliteStoryStore(path.join(directory, 'novel.sqlite'));
const p = store.createProject(projectInputSchema.parse({ title: '百万字工程测试数据' }));
const started = performance.now();
for (let i = 1; i <= 400; i++) {
  const sentence = `第${i}日，沈砚沿着堤岸走向钟楼。林舟在档案馆等待。他们核对了旧名册里的名字，并把新的发现记在纸上。`;
  const text = Array.from(
    { length: Math.ceil(2600 / countChars(sentence)) },
    (_, n) => `${sentence}这是第${n}条记录。`,
  ).join('\n\n');
  const run = store.createRun(p.id, runInputSchema.parse({ kind: 'write' }), `scale-${i}`);
  store.claim('scale', 30000);
  store.commitGenerated(
    run.id,
    'scale',
    store.getProject(p.id).revision,
    `记录${i}`,
    text,
    { findings: [], strengths: [] },
    [
      {
        subject: '沈砚',
        predicate: '位置',
        value: '钟楼',
        kind: 'state',
        holder: null,
        storyTime: `第${i}日`,
        quote: sentence,
      },
    ],
    `第${i}日抵达钟楼`,
  );
  store.patchRun(run.id, 'scale', { status: 'completed' });
}
const times: number[] = [];
for (let i = 0; i < 40; i++) {
  const t = performance.now();
  const hits = store.search(p.id, i % 2 ? '林舟 档案馆 名册' : '沈砚 钟楼');
  if (!hits.length) throw new Error('检索无结果');
  times.push(performance.now() - t);
}
times.sort((a, b) => a - b);
const totalChars = store.chapters(p.id).reduce((n, c) => n + c.chars, 0);
const exported = JSON.stringify(store.exportProject(p.id));
writeFileSync(path.join(directory, 'export.json'), exported);
await store.backup(path.join(directory, 'backup.sqlite'));
const restored = new SqliteStoryStore(path.join(directory, 'backup.sqlite'));
const restoredChars = restored.chapters(p.id).reduce((n, c) => n + c.chars, 0);
restored.close();
const report = {
  fixture: 'synthetic-repetitive-load-only',
  chapters: 400,
  totalChars,
  restoredChars,
  elapsedMs: performance.now() - started,
  searchP95Ms: times[Math.floor(times.length * 0.95)]!,
  exportBytes: Buffer.byteLength(exported),
  passed:
    totalChars >= 1000000 && restoredChars === totalChars && times[Math.floor(times.length * 0.95)]! < 1000,
  limitation: '合成数据仅证明容量、检索与备份，不证明生成质量或语义检索质量',
};
writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, directory }, null, 2));
store.close();
process.exitCode = report.passed ? 0 : 1;
