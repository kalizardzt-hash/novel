import type { Chapter, Entity, Project, Run } from '../../../packages/domain/src/index.ts';
export type ChapterSummary = Omit<Chapter, 'text'>;
export type Workspace = {
  project: Project;
  entities: Entity[];
  chapters: ChapterSummary[];
  runs: Run[];
  impacts: { chapterId: string; title: string; reason: string }[];
  stats: { chars: number; chapters: number };
};
export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch('/api/v1' + url, {
    ...init,
    headers: {
      ...(init?.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...init?.headers,
    },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `请求失败 ${response.status}`);
  return data as T;
}
export const send = <T>(url: string, body: unknown, method = 'POST') =>
  api<T>(url, { method, body: JSON.stringify(body), headers: { 'Idempotency-Key': crypto.randomUUID() } });
export const statusLabels: Record<string, string> = {
  queued: '等待执行',
  running: '正在创作',
  awaiting_approval: '等待确认',
  paused: '已暂停',
  completed: '已完成',
  failed: '待处理',
  cancelled: '已取消',
  draft: '草稿',
  accepted: '已收录',
  stale: '待复核',
  canon: '正式设定',
  proposed: '待确认',
  retired: '已退役',
};
export const taskLabels: Record<string, string> = {
  blueprint: '全书蓝图',
  volume: '卷纲规划',
  plan: '章节规划',
  write: '正文创作',
  rewrite: '情节改写',
  polish: '语言润色',
  review: '独立审校',
  extract: '记忆收录',
  ingest: '顺序审校收录',
  intent: '意图识别',
  reindex: '语义索引',
  summarize: '层级摘要',
  audit: '全书收束审计',
  repair: '定点修订',
  verify_review: '审校证据复核',
};
