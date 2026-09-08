import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SqliteStoryStore } from '../../infrastructure/src/store.ts';
import { createRunner } from '../../infrastructure/src/runtime.ts';
import { dataDirectory, readConfig } from '../../infrastructure/src/config.ts';
import {
  entityInputSchema,
  projectInputSchema,
  runInputSchema,
  type Review,
} from '../../domain/src/index.ts';
import { sourceReceipt } from './receipt.ts';
const directory = path.join(dataDirectory(), 'evaluations', `continuity-${Date.now()}`);
mkdirSync(directory, { recursive: true });
const store = new SqliteStoryStore(path.join(directory, 'novel.sqlite'));
const fixtures = [
  {
    name: '未经交接的唯一物品',
    text: '余鹤拆开信封，信纸中间夹着唯一的银钥匙。他拿起它，打开档案柜。这是故事开始的同一时刻，姜禾仍把那把银钥匙锁在她的保险箱里。',
    blocked: true,
  },
  {
    name: '把另一人物秘密当成主角知识',
    text: '余鹤第一次见到姜禾。他没有听过任何有关档案的消息，也没有收到线索。“我知道你去年偷偷销毁了三页档案。”余鹤肯定地说出了事实。',
    blocked: true,
  },
  {
    name: '合理模糊时间不应误报',
    text: '今天是周三傍晚，工地定在周五清晨封闭，剩下不到两天。余鹤走到门边，停下来等姜禾。她握着银钥匙进屋，同意帮忙，把钥匙亲手交给他。余鹤道谢后，用它打开档案柜。',
    blocked: false,
  },
];
const results: unknown[] = [];
const config = readConfig();
const source = sourceReceipt();
for (const fixture of fixtures) {
  const p = store.createProject(
    projectInputSchema.parse({ title: fixture.name, pov: '第三人称限知，余鹤视角' }),
  );
  for (const card of [
    { kind: 'character', name: '余鹤', fields: { 身份与角色: '首次来访者' } },
    { kind: 'character', name: '姜禾', fields: { 秘密: '去年偷偷销毁了三页档案' } },
    {
      kind: 'item',
      name: '银钥匙',
      fields: {
        开篇保管人: '姜禾',
        数量: '唯一一把，无复制件',
        转移规则: '只有姜禾明确同意并完成交接，持有人才能改变',
      },
    },
  ])
    store.saveEntity(p.id, entityInputSchema.parse(card), store.getProject(p.id).revision);
  const c = store.saveChapter(
    p.id,
    { title: '待审正文', text: fixture.text, volume: 1 },
    store.getProject(p.id).revision,
  );
  const r = store.createRun(p.id, runInputSchema.parse({ kind: 'review', chapterId: c.id }), fixture.name);
  store.claim('evaluation', 60000);
  const timer = setInterval(() => store.heartbeat(r.id, 'evaluation', 60000), 10000);
  try {
    await createRunner(store, config).execute(r.id, 'evaluation', new AbortController().signal);
  } finally {
    clearInterval(timer);
  }
  const result = store.getRun(r.id);
  const review = result.result as Review | null;
  const blocked = review?.findings.some((f) => f.severity !== 'minor') ?? false;
  const record = {
    name: fixture.name,
    expectedBlocked: fixture.blocked,
    actualBlocked: blocked,
    passed: result.status === 'completed' && blocked === fixture.blocked,
    status: result.status,
    error: result.error,
    review,
    runId: r.id,
  };
  results.push(record);
  console.log(JSON.stringify(record));
}
writeFileSync(
  path.join(directory, 'report.json'),
  JSON.stringify(
    { source, config, fixtures, results, limitation: '小型回归样例，不证明复杂小说连续性' },
    null,
    2,
  ),
);
store.close();
console.log(directory);
process.exitCode = results.every((result) => (result as { passed: boolean }).passed) ? 0 : 1;
