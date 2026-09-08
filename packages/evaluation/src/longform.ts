import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SqliteStoryStore } from '../../infrastructure/src/store.ts';
import { dataDirectory, readConfig } from '../../infrastructure/src/config.ts';
import { createRunner } from '../../infrastructure/src/runtime.ts';
import { sourceReceipt } from './receipt.ts';
import {
  projectInputSchema,
  entityInputSchema,
  runInputSchema,
  type BookOutline,
} from '../../domain/src/index.ts';
const directory = path.join(dataDirectory(), 'evaluations', `longform-${Date.now()}`);
mkdirSync(directory, { recursive: true });
const store = new SqliteStoryStore(path.join(directory, 'novel.sqlite'));
const config = readConfig();
const source = sourceReceipt();
writeFileSync(path.join(directory, 'source-receipt.json'), JSON.stringify(source, null, 2));
// Frozen original fiction fixture: integration evidence, never represented as a full novel.
const p = store.createProject(
  projectInputSchema.parse({
    title: '雨港的第十三封信',
    genre: '现实悬疑',
    premise:
      '雨港的修钟师沈砚收到失踪父亲留下的第十三封信。信里没有答案，只让他在旧钟楼拆迁前取回一本名册。他与档案员林舟追查名册的去向，逐渐发现父亲曾为保护工人隐瞒事故。故事由选择公开真相及承担代价结束。',
    chapterTarget: 600,
    targetChars: 20000,
    tone: '克制朴素；细节推动情节；人物通过行动表达情绪',
    pov: '第三人称限知，沈砚视角',
  }),
);
const outline: BookOutline = {
  premise: p.premise,
  theme: '保护一个人的沉默是否会伤害更多人',
  ending: '沈砚公开事故名册，并承认父亲的隐瞒，旧钟楼被保留为档案馆。',
  volumes: [
    {
      number: 1,
      title: '雨里的名册',
      goal: '查清名册去向与事故真相',
      endState: '沈砚决定公开档案',
      promises: ['第十三封信的来源得到解释', '铜钥匙最终打开档案柜'],
    },
  ],
  characters: [
    {
      name: '沈砚',
      role: '修钟师',
      desire: '查清父亲失踪原因',
      weakness: '不愿相信父亲有错',
      voice: '话少，用物件与细节说话',
      arc: '从维护父亲名誉到承担真相',
      secret: '曾藏起前十二封信',
    },
    {
      name: '林舟',
      role: '档案员',
      desire: '保住事故档案',
      weakness: '害怕丢掉工作',
      voice: '谨慎准确，避免承诺',
      arc: '从回避到作证',
      secret: '知道事故名册曾被调走',
    },
  ],
  worldRules: [
    {
      name: '铜钥匙唯一性',
      condition: '打开旧档案柜',
      effect: '可取出名册',
      limit: '只有一把，无复制件',
      cost: '必须让保管人同意交出',
    },
  ],
};
const owner = randomUUID();
const bootstrap = store.createRun(p.id, runInputSchema.parse({ kind: 'blueprint' }), 'fixture-blueprint');
store.claim(owner, 60000);
store.completeBlueprint(bootstrap.id, owner, outline);
store.approveRun(bootstrap.id, store.getProject(p.id).revision);
const v = store.createRun(p.id, runInputSchema.parse({ kind: 'volume' }), 'fixture-volume');
store.claim(owner, 60000);
store.completeVolume(v.id, owner, {
  number: 1,
  title: '雨里的名册',
  goal: '查明名册去向',
  endState: '决定公开',
  milestones: ['父亲来信', '寻找档案员', '追查钥匙', '打开档案柜', '公开事故名册'],
  characterArcs: ['沈砚逐步接受父亲的错误'],
  promises: ['铜钥匙归属连续'],
  chapterCount: 12,
  approved: false,
});
store.approveRun(v.id, store.getProject(p.id).revision);
store.saveEntity(
  p.id,
  entityInputSchema.parse({
    kind: 'item',
    name: '铜钥匙',
    fields: { 数量: '唯一一把', 开篇保管人: '林舟', 用途: '打开旧档案柜' },
  }),
  store.getProject(p.id).revision,
);
const count = Number(process.env.NOVEL_EVAL_CHAPTERS ?? 10);
const run = store.createRun(
  p.id,
  runInputSchema.parse({
    kind: 'write',
    count,
    instruction: '本次为连续章节验证。每章约600字，规划只列1个场景；保持人物、时间、伏笔与铜钥匙归属。',
  }),
  'longform',
);
store.claim(owner, 60000);
const abort = new AbortController();
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => abort.abort());
const started = Date.now();
const timer = setInterval(() => {
  store.heartbeat(run.id, owner, 60000);
  const r = store.getRun(run.id);
  console.log(
    JSON.stringify({ at: new Date().toISOString(), completed: r.progress, step: r.step, status: r.status }),
  );
}, 10000);
try {
  await createRunner(store, config).execute(run.id, owner, abort.signal);
} finally {
  clearInterval(timer);
}
const result = store.getRun(run.id);
const chapters = store.chapters(p.id);
const report = {
  fixture: 'original-rain-harbor-v1',
  targetChapters: count,
  targetCharsPerChapter: 600,
  completedChapters: chapters.filter((c) => c.status === 'accepted').length,
  actualChars: chapters.reduce((n, c) => n + c.chars, 0),
  elapsedMs: Date.now() - started,
  run: result,
  config,
  source,
  limitations: [
    '固定蓝图用于隔离连续写作能力，不证明自动规划质量',
    '600字短章验证，不等同于百万字或标准长章验收',
    '尚需人工文学评审',
  ],
  passed: result.status === 'completed' && chapters.length === count,
};
writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
writeFileSync(
  path.join(directory, 'manuscript.md'),
  chapters.map((c) => `## 第${c.number}章 ${c.title}\n\n${c.text}`).join('\n\n'),
);
writeFileSync(path.join(directory, 'project.json'), JSON.stringify(store.exportProject(p.id), null, 2));
console.log(
  JSON.stringify({
    report: path.join(directory, 'report.json'),
    passed: report.passed,
    chapters: chapters.length,
    error: result.error,
  }),
);
store.close();
process.exitCode = report.passed ? 0 : 1;
