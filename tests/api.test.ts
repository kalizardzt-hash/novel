import { afterEach, expect, it } from 'vitest';
import { buildApp, splitManuscript } from '../apps/server/src/app.ts';
import { SqliteStoryStore } from '../packages/infrastructure/src/store.ts';
const resources: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of resources.splice(0)) await close();
});
async function setup() {
  const store = new SqliteStoryStore(':memory:');
  const app = await buildApp(store, { webRoot: '/nonexistent-test' });
  resources.push(async () => {
    await app.close();
    store.close();
  });
  return { app, store };
}
it('API 完成建书、设定卡、版本冲突和导出', async () => {
  const { app } = await setup();
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/projects',
    payload: { title: '河岸', premise: '一个修钟师寻找父亲' },
  });
  expect(created.statusCode).toBe(201);
  const p = created.json();
  const card = await app.inject({
    method: 'POST',
    url: `/api/v1/projects/${p.id}/entities`,
    payload: { revision: p.revision, kind: 'character', name: '沈砚', fields: { 欲望: '寻找父亲' } },
  });
  expect(card.statusCode).toBe(200);
  const stale = await app.inject({
    method: 'PUT',
    url: `/api/v1/projects/${p.id}`,
    payload: { ...p, title: '错误版本' },
  });
  expect(stale.statusCode).toBe(409);
  const exported = await app.inject(`/api/v1/projects/${p.id}/export?format=json`);
  expect(exported.json().entities[0].name).toBe('沈砚');
});
it('拒绝跨域写入、恶意 Host 以及缺失幂等键的任务', async () => {
  const { app, store } = await setup();
  const created = await app.inject({ method: 'POST', url: '/api/v1/projects', payload: { title: 'test' } });
  const p = created.json();
  expect(
    (await app.inject({ method: 'POST', url: `/api/v1/projects/${p.id}/runs`, payload: { kind: 'write' } }))
      .statusCode,
  ).toBe(400);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/projects',
        headers: { origin: 'https://evil.example' },
        payload: { title: 'bad' },
      })
    ).statusCode,
  ).toBe(403);
  expect((await app.inject({ url: '/api/v1/health', headers: { host: 'evil.example' } })).statusCode).toBe(
    403,
  );
  expect(store.listProjects()).toHaveLength(1);
});
it('同一任务请求重复提交返回同一个 run', async () => {
  const { app } = await setup();
  const p = (
    await app.inject({ method: 'POST', url: '/api/v1/projects', payload: { title: 'test' } })
  ).json();
  const request = {
    method: 'POST' as const,
    url: `/api/v1/projects/${p.id}/runs`,
    headers: { 'idempotency-key': 'same' },
    payload: { kind: 'write' },
  };
  const a = await app.inject(request);
  const b = await app.inject(request);
  expect(a.statusCode).toBe(202);
  expect(a.json().id).toBe(b.json().id);
});
it('导入识别中文章标题及 Markdown 并保留正文', () => {
  expect(splitManuscript('第一章 雨\n\n下雨了。\n\n第二章 信\n信来了。', 'file')).toEqual([
    { title: '第一章 雨', text: '下雨了。' },
    { title: '第二章 信', text: '信来了。' },
  ]);
  expect(() => splitManuscript('', 'empty')).toThrow('没有正文');
});

it('SSE 从最新游标订阅，服务关闭能结束持久连接', async () => {
  const { app, store } = await setup();
  const created = await app.inject({ method: 'POST', url: '/api/v1/projects', payload: { title: '事件流' } });
  const p = created.json();
  store.event(p.id, null, 'old', { text: '不重播旧预览' });
  const oldCursor = store.latestEventId(p.id);
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const response = await fetch(`${address}/api/v1/projects/${p.id}/events?live=1`, {
    signal: AbortSignal.timeout(5000),
  });
  const reader = response.body!.getReader();
  store.event(p.id, null, 'new', { text: '新的正文' });
  let received = '';
  while (!received.includes('新的正文')) {
    const chunk = await reader.read();
    if (chunk.done) break;
    received += new TextDecoder().decode(chunk.value);
  }
  expect(received).not.toContain('不重播旧预览');
  expect(store.events(p.id, oldCursor).map((e) => e.type)).toEqual(['new']);
  await app.close();
  await reader.cancel();
});
