import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import staticFiles from '@fastify/static';
import { z } from 'zod';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerResponse } from 'node:http';
import {
  DomainError,
  projectInputSchema,
  entityInputSchema,
  chapterInputSchema,
  runInputSchema,
} from '../../../packages/domain/src/index.ts';
import { cardTemplates } from '../../../packages/domain/src/templates.ts';
import type { StoryStore } from '../../../packages/application/src/ports.ts';
import { dataDirectory, readConfig, writeConfig } from '../../../packages/infrastructure/src/config.ts';
import { OpenAICompatibleModel } from '../../../packages/infrastructure/src/openai.ts';
import { EXTERNAL_PROVIDERS, LOCAL_SERVICES, probeServices } from '../../../packages/infrastructure/src/providers.ts';
const idOf = (value: unknown) => z.object({ id: z.string().min(1) }).parse(value).id;
const revision = (value: unknown) =>
  z.object({ revision: z.number().int().positive() }).passthrough().parse(value).revision;
export async function buildApp(store: StoryStore, options: { logger?: boolean; webRoot?: string } = {}) {
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 64 * 1024 * 1024 });
  const streams = new Set<ServerResponse>();
  app.addHook('preClose', async () => {
    for (const stream of streams) stream.end();
  });
  app.addHook('onRequest', async (request, reply) => {
    const host = request.headers.host?.split(':')[0];
    if (host && !['127.0.0.1', 'localhost', '['].includes(host))
      return reply.code(403).send({ error: '仅允许本机访问' });
    const origin = request.headers.origin;
    if (origin) {
      let valid = false;
      try {
        const url = new URL(origin);
        valid =
          ['localhost', '127.0.0.1'].includes(url.hostname) &&
          [String(readConfig().port), '5173'].includes(url.port);
      } catch {}
      if (!valid) return reply.code(403).send({ error: '请求来源不被允许' });
    }
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError)
      return reply.code(400).send({ error: '输入不符合要求', details: error.issues });
    if (error instanceof DomainError)
      return reply.code(error.statusCode).send({ error: error.message, code: error.code });
    app.log.error(error);
    return reply.code(500).send({ error: error instanceof Error ? error.message : '服务错误' });
  });
  await app.register(multipart, { limits: { fileSize: 64 * 1024 * 1024, files: 1 } });
  app.get('/api/v1/health', () => {
    const file = path.join(dataDirectory(), 'worker-health.json');
    let worker: unknown = null;
    try {
      worker = JSON.parse(readFileSync(file, 'utf8'));
    } catch {}
    return { status: 'ok', worker, model: readConfig().model.identifier || '自动选择已加载模型' };
  });
  app.get('/api/v1/templates', () => cardTemplates);
  app.get('/api/v1/config', () => readConfig());
  app.put('/api/v1/config', (request) => writeConfig(request.body));
  app.get('/api/v1/models', async () => {
    const config = readConfig();
    const adapter = new OpenAICompatibleModel(config.model);
    return {
      models: await adapter.listModels().catch(() => []),
      selected: await adapter.info().catch((e) => ({ error: e.message })),
    };
  });
  // 探测本机 OpenAI 兼容服务（无 Key、只访问回环地址），外部提供商返回静态预设。
  app.get('/api/v1/providers', async () => {
    const configured = readConfig().model.baseUrl;
    let host = '';
    try {
      host = new URL(configured).hostname;
    } catch {}
    const loopback = ['127.0.0.1', 'localhost', '[::1]', '::1'];
    const extra =
      loopback.includes(host) && !LOCAL_SERVICES.some((s) => s.baseUrl === configured)
        ? [{ name: '当前配置地址', baseUrl: configured }]
        : [];
    return { local: await probeServices([...LOCAL_SERVICES, ...extra]), external: EXTERNAL_PROVIDERS };
  });
  app.get('/api/v1/projects', () => store.listProjects());
  app.post('/api/v1/projects', (request, reply) =>
    reply.code(201).send(store.createProject(projectInputSchema.parse(request.body))),
  );
  app.get('/api/v1/projects/:id', (request) => {
    const id = idOf(request.params);
    const chapters = store.chapters(id);
    return {
      project: store.getProject(id),
      entities: store.entities(id),
      chapters: chapters.map(({ text, ...c }) => c),
      runs: store.runs(id),
      impacts: store.impacts(id),
      stats: {
        chars: chapters.filter((c) => c.status === 'accepted').reduce((s, c) => s + c.chars, 0),
        chapters: chapters.length,
      },
    };
  });
  app.put('/api/v1/projects/:id', (request) =>
    store.updateProject(idOf(request.params), projectInputSchema.parse(request.body), revision(request.body)),
  );
  app.post('/api/v1/projects/:id/entities', (request) =>
    store.saveEntity(idOf(request.params), entityInputSchema.parse(request.body), revision(request.body)),
  );
  app.put('/api/v1/projects/:id/entities/:entityId', (request) => {
    const p = z.object({ id: z.string(), entityId: z.string() }).parse(request.params);
    return store.saveEntity(p.id, entityInputSchema.parse(request.body), revision(request.body), p.entityId);
  });
  app.post('/api/v1/projects/:id/chapters', (request) =>
    store.saveChapter(idOf(request.params), chapterInputSchema.parse(request.body), revision(request.body)),
  );
  app.get('/api/v1/chapters/:id', (request) => store.getChapter(idOf(request.params)));
  app.put('/api/v1/chapters/:id', (request) => {
    const id = idOf(request.params);
    const c = store.getChapter(id);
    return store.saveChapter(c.projectId, chapterInputSchema.parse(request.body), revision(request.body), id);
  });
  app.get('/api/v1/chapters/:id/revisions', (request) => store.revisions(idOf(request.params)));
  app.post('/api/v1/chapters/:id/restore', (request) => {
    const id = idOf(request.params);
    const body = z
      .object({ revision: z.number().int(), sourceRevision: z.number().int() })
      .parse(request.body);
    const c = store.getChapter(id);
    const prev = store.revisions(id).find((r) => r.revision === body.sourceRevision);
    if (!prev) throw new DomainError('NOT_FOUND', '历史修订不存在', 404);
    return store.saveChapter(
      c.projectId,
      { title: prev.title, text: prev.text, volume: c.volume },
      body.revision,
      id,
      `恢复历史版本 ${body.sourceRevision}`,
    );
  });
  app.get('/api/v1/projects/:id/memory', (request) => {
    const q = z
      .object({ query: z.string().default(''), offset: z.coerce.number().int().min(0).default(0) })
      .parse(request.query);
    const id = idOf(request.params);
    const facts = store.facts(id);
    return {
      facts: facts.slice(q.offset, q.offset + 100),
      total: facts.length,
      digests: store.digests(id),
      hits: q.query ? store.search(id, q.query) : [],
    };
  });
  app.post('/api/v1/projects/:id/runs', (request, reply) => {
    const key = z.string().min(1).max(200).parse(request.headers['idempotency-key']);
    return reply
      .code(202)
      .send(store.createRun(idOf(request.params), runInputSchema.parse(request.body), key));
  });
  app.get('/api/v1/runs/:id', (request) => store.getRun(idOf(request.params)));
  app.get('/api/v1/runs/:id/traces', (request) => store.traces(idOf(request.params)));
  app.post('/api/v1/runs/:id/control', (request) =>
    store.controlRun(
      idOf(request.params),
      z.object({ action: z.enum(['pause', 'resume', 'cancel']) }).parse(request.body).action,
    ),
  );
  app.post('/api/v1/runs/:id/approve', (request) =>
    store.approveRun(idOf(request.params), revision(request.body)),
  );
  app.put('/api/v1/runs/:id/proposal', (request) =>
    store.reviseProposal(
      idOf(request.params),
      revision(request.body),
      z.object({ result: z.unknown() }).parse(request.body).result,
    ),
  );
  app.post('/api/v1/runs/:id/apply-revision', (request) => {
    const run = store.getRun(idOf(request.params));
    if (!['rewrite', 'polish'].includes(run.kind) || run.status !== 'completed' || !run.chapterId)
      throw new DomainError('INVALID_RUN', '没有可应用的修订建议');
    const result = z.object({ text: z.string() }).passthrough().parse(run.result);
    const current = store.getChapter(run.chapterId);
    if (run.baseRevision !== revision(request.body))
      throw new DomainError('REVISION_CONFLICT', '修订建议基于旧资料；请对比后手工合并', 409);
    return store.saveChapter(
      run.projectId,
      { title: current.title, text: result.text, volume: current.volume },
      revision(request.body),
      current.id,
      '应用修订建议',
    );
  });
  app.get('/api/v1/projects/:id/events', (request, reply) => {
    const id = idOf(request.params);
    store.getProject(id);
    const query = z
      .object({
        after: z.coerce.number().int().min(0).default(0),
        once: z.string().optional(),
        live: z.literal('1').optional(),
      })
      .parse(request.query);
    let cursor = Number(
      request.headers['last-event-id'] ?? (query.live ? store.latestEventId(id) : query.after),
    );
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new DomainError('INVALID_CURSOR', '事件游标无效');
    if (query.once) return store.events(id, cursor);
    reply.hijack();
    streams.add(reply.raw);
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = () => {
      // 连接关闭与定时器之间存在竞态；写入已关闭的流会抛错并击垮服务进程。
      if (reply.raw.writableEnded || reply.raw.destroyed) return;
      try {
        for (const event of store.events(id, cursor)) {
          reply.raw.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
          cursor = event.id;
        }
        reply.raw.write(': heartbeat\n\n');
      } catch {
        /* 客户端断开由 close 处理器清理 */
      }
    };
    send();
    const timer = setInterval(send, 1000);
    reply.raw.on('close', () => {
      clearInterval(timer);
      streams.delete(reply.raw);
    });
  });
  app.post('/api/v1/projects/:id/import', async (request) => {
    const id = idOf(request.params);
    const project = store.getProject(id);
    const file = await request.file();
    if (!file) throw new DomainError('FILE_REQUIRED', '请选择 TXT 或 Markdown 文件');
    if (!/\.(txt|md|markdown)$/i.test(file.filename))
      throw new DomainError('INVALID_FILE', '仅支持 TXT 或 Markdown');
    const bytes = await file.toBuffer();
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      text = new TextDecoder('gb18030', { fatal: true }).decode(bytes);
    }
    const parsed = splitManuscript(text, file.filename.replace(/\.[^.]+$/, ''));
    const imported = store.importChapters(
      id,
      parsed.map((part) => ({ ...part, volume: 1 })),
      project.revision,
    );
    return {
      imported: imported.length,
      message: '原文已导入为草稿。按章节顺序执行审校与记忆收录后可以续写。',
    };
  });
  app.get('/api/v1/projects/:id/export', (request, reply) => {
    const id = idOf(request.params);
    const project = store.getProject(id);
    const format = z
      .object({ format: z.enum(['txt', 'md', 'json']).default('md') })
      .parse(request.query).format;
    reply.header(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(project.title + '.' + format)}`,
    );
    if (format === 'json') return reply.type('application/json').send(store.exportProject(id));
    return reply.type('text/plain; charset=utf-8').send(
      store
        .chapters(id)
        .map((c) => `${format === 'md' ? '## ' : ''}第${c.number}章 ${c.title}\n\n${c.text}`)
        .join('\n\n'),
    );
  });
  app.post('/api/v1/import-project', (request) => store.importProject(request.body));
  app.post('/api/v1/backup', async () => {
    const directory = path.join(dataDirectory(), 'backups');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const name = `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}.sqlite`;
    await store.backup(path.join(directory, name));
    return { filename: name, path: path.join(directory, name) };
  });
  const root = options.webRoot ?? fileURLToPath(new URL('../../web/dist/', import.meta.url));
  if (existsSync(root)) {
    await app.register(staticFiles, { root });
    app.setNotFoundHandler((request, reply) =>
      request.url.startsWith('/api/')
        ? reply.code(404).send({ error: '接口不存在' })
        : reply.sendFile('index.html'),
    );
  }
  return app;
}
export function splitManuscript(text: string, fallback: string): { title: string; text: string }[] {
  const lines = text
    .replace(/^\uFEFF/, '')
    .replaceAll('\r\n', '\n')
    .split('\n');
  const result: { title: string; text: string }[] = [];
  let title = fallback;
  let body: string[] = [];
  for (const line of lines) {
    if (
      /^(?:#{1,3}\s*)?第[一二三四五六七八九十百千万零〇两\d]+[章节回卷][\s\S]*$/.test(line.trim()) ||
      /^#{1,3}\s+/.test(line)
    ) {
      if (body.join('\n').trim()) result.push({ title, text: body.join('\n').trim() });
      title = line.replace(/^#+\s*/, '').trim();
      body = [];
    } else body.push(line);
  }
  if (body.join('\n').trim()) result.push({ title, text: body.join('\n').trim() });
  if (!result.length) throw new DomainError('EMPTY_FILE', '文件没有正文');
  return result;
}
