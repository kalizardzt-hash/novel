import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { desc } from 'drizzle-orm';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  DomainError,
  blueprintSchema,
  volumeSchema,
  entityInputSchema,
  projectInputSchema,
  chapterInputSchema,
  countChars,
  searchable,
  verifyFacts,
  type BookOutline,
  type Chapter,
  type ChapterRevision,
  type ContextManifest,
  type Entity,
  type EntityInput,
  type Evidence,
  type ExtractedFact,
  type MemoryFact,
  type Project,
  type ProjectInput,
  type Review,
  type Run,
  type RunEvent,
  type RunInput,
  type VolumePlan,
  type ChapterDigest,
  type StoryDigest,
} from '../../domain/src/index.ts';
import type { Message, StoryStore } from '../../application/src/ports.ts';
import { migrations, projectTable } from './schema.ts';

const now = () => new Date().toISOString();
const json = JSON.stringify;
type Row = Record<string, string | number | null>;
export class SqliteStoryStore implements StoryStore {
  readonly db: Database.Database;
  readonly orm: ReturnType<typeof drizzle>;
  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
    );
    for (const m of migrations)
      if (!this.db.prepare('SELECT 1 FROM migrations WHERE version=?').get(m.version)) {
        this.db
          .transaction(() => {
            this.db.exec(m.sql);
            this.db.prepare('INSERT INTO migrations VALUES (?,?)').run(m.version, now());
          })
          .immediate();
      }
    this.orm = drizzle(this.db);
  }
  private all<T>(sql: string, ...args: (string | number | null)[]): T[] {
    return (this.db.prepare(sql).all(...args) as Row[]).map((row) => JSON.parse(String(row.payload)) as T);
  }
  private one<T>(sql: string, ...args: (string | number | null)[]): T {
    const result = this.all<T>(sql, ...args)[0];
    if (!result) throw new DomainError('NOT_FOUND', '记录不存在', 404);
    return result;
  }
  private putProject(p: Project) {
    this.db
      .prepare('UPDATE projects SET revision=?,payload=?,updated_at=? WHERE id=?')
      .run(p.revision, json(p), p.updatedAt, p.id);
  }
  private bump(id: string, expected: number): Project {
    const p = this.getProject(id);
    if (p.revision !== expected)
      throw new DomainError(
        'REVISION_CONFLICT',
        '资料已被修改，请刷新后复核；旧版本生成结果不会覆盖新稿',
        409,
      );
    const next = { ...p, revision: p.revision + 1, updatedAt: now() };
    this.putProject(next);
    return next;
  }
  listProjects(): Project[] {
    return this.orm
      .select()
      .from(projectTable)
      .orderBy(desc(projectTable.updatedAt))
      .all()
      .map((row) => JSON.parse(row.payload) as Project);
  }
  getProject(id: string): Project {
    return this.one('SELECT payload FROM projects WHERE id=?', id);
  }
  createProject(input: ProjectInput): Project {
    const p: Project = {
      ...projectInputSchema.parse(input),
      id: randomUUID(),
      revision: 1,
      outline: null,
      approved: false,
      volumes: {},
      createdAt: now(),
      updatedAt: now(),
    };
    this.db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run(p.id, p.revision, json(p), p.updatedAt);
    return p;
  }
  updateProject(id: string, input: ProjectInput, revision: number): Project {
    return this.db
      .transaction(() => {
        const prev = this.getProject(id);
        const p = this.bump(id, revision);
        const changed = ['premise', 'genre', 'tone', 'pov', 'boundaries', 'styleSample'].some(
          (k) => prev[k as keyof Project] !== input[k as keyof ProjectInput],
        );
        const next = { ...p, ...projectInputSchema.parse(input), approved: changed ? false : p.approved };
        this.putProject(next);
        if (changed) this.invalidate(id, 0, 'project-settings', '创作设定已变更，需要复核连续性');
        return next;
      })
      .immediate();
  }
  entities(projectId: string): Entity[] {
    this.getProject(projectId);
    return this.all('SELECT payload FROM entities WHERE project_id=? ORDER BY rowid', projectId);
  }
  saveEntity(projectId: string, input: EntityInput, revision: number, id?: string): Entity {
    return this.db
      .transaction(() => {
        this.bump(projectId, revision);
        const previous = id
          ? this.one<Entity>('SELECT payload FROM entities WHERE id=? AND project_id=?', id, projectId)
          : null;
        const data = entityInputSchema.parse(input);
        if (data.narrativeTo !== null && data.narrativeTo < data.narrativeFrom)
          throw new DomainError('INVALID_RANGE', '生效结束章节不能早于开始章节');
        for (const ref of [data.fromEntityId, data.toEntityId])
          if (ref) this.one('SELECT payload FROM entities WHERE id=? AND project_id=?', ref, projectId);
        const e: Entity = {
          ...data,
          id: id ?? randomUUID(),
          projectId,
          revision: (previous?.revision ?? 0) + 1,
          createdAt: previous?.createdAt ?? now(),
          updatedAt: now(),
        };
        this.db
          .prepare(
            'INSERT INTO entities VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',
          )
          .run(e.id, projectId, json(e));
        this.index(
          e.id,
          projectId,
          'entity',
          [e.name, ...e.aliases, e.description, ...Object.values(e.fields)].join('\n'),
        );
        if ((previous?.status === 'canon' || e.status === 'canon') && this.chapters(projectId).length)
          this.invalidate(
            projectId,
            e.narrativeFrom,
            e.id,
            `设定「${e.name}」已更新；保守复核生效范围内的正文`,
          );
        this.event(projectId, null, 'entity.updated', { id: e.id });
        return e;
      })
      .immediate();
  }
  chapters(projectId: string): Chapter[] {
    this.getProject(projectId);
    return this.all('SELECT payload FROM chapters WHERE project_id=? ORDER BY number', projectId);
  }
  getChapter(id: string): Chapter {
    return this.one('SELECT payload FROM chapters WHERE id=?', id);
  }
  private writeChapter(c: Chapter, reason: string) {
    this.db
      .prepare(
        'INSERT INTO chapters VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,status=excluded.status,payload=excluded.payload',
      )
      .run(c.id, c.projectId, c.number, c.revision, c.status, json(c));
    const revision: ChapterRevision = {
      id: randomUUID(),
      chapterId: c.id,
      revision: c.revision,
      title: c.title,
      text: c.text,
      reason,
      createdAt: now(),
    };
    this.db
      .prepare('INSERT INTO revisions VALUES (?,?,?,?)')
      .run(revision.id, c.id, c.revision, json(revision));
    this.index(c.id, c.projectId, 'chapter', c.title + '\n' + c.text);
  }
  private invalidate(projectId: string, from: number, source: string, reason: string) {
    const affected = this.chapters(projectId).filter((c) => c.number >= from);
    for (const c of affected) {
      if (c.status === 'accepted') {
        c.status = 'stale';
        this.db.prepare('UPDATE chapters SET status=?,payload=? WHERE id=?').run(c.status, json(c), c.id);
      }
      this.db.prepare('UPDATE memories SET valid=0 WHERE chapter_id=?').run(c.id);
      this.db
        .prepare(
          'INSERT INTO impacts VALUES (?,?,?,0) ON CONFLICT(chapter_id,source_id) DO UPDATE SET reason=excluded.reason,resolved=0',
        )
        .run(c.id, source, reason);
    }
  }
  chapterDigests(projectId: string): ChapterDigest[] {
    return (
      this.db
        .prepare(
          "SELECT c.payload,s.summary FROM summaries s JOIN chapters c ON c.id=s.chapter_id WHERE c.project_id=? AND c.status='accepted' AND c.revision=s.revision ORDER BY c.number",
        )
        .all(projectId) as Row[]
    ).map((row) => {
      const chapter = JSON.parse(String(row.payload)) as Chapter;
      return {
        chapterId: chapter.id,
        revision: chapter.revision,
        number: chapter.number,
        volume: chapter.volume,
        title: chapter.title,
        summary: String(row.summary),
      };
    });
  }
  digests(projectId: string): StoryDigest[] {
    const chapters = new Map(this.chapters(projectId).map((c) => [c.id, c]));
    return this.all<StoryDigest>(
      'SELECT payload FROM digests WHERE project_id=? ORDER BY rowid',
      projectId,
    ).map((d) => ({
      ...d,
      valid:
        d.sources.length > 0 &&
        d.sources.every((s) => {
          const c = chapters.get(s.chapterId);
          return c?.status === 'accepted' && c.revision === s.revision;
        }),
    }));
  }
  saveDigest(
    runId: string,
    owner: string,
    input: Omit<StoryDigest, 'id' | 'projectId' | 'valid' | 'createdAt'>,
  ): StoryDigest {
    return this.db
      .transaction(() => {
        const run = this.owned(runId, owner);
        if (run.request === 'cancel') throw new DomainError('CANCELLED', '已取消');
        if (this.getProject(run.projectId).revision !== run.baseRevision)
          throw new DomainError('REVISION_CONFLICT', '摘要来源已变化', 409);
        if (
          !input.sources.length ||
          input.sources.some((s) => {
            const c = this.getChapter(s.chapterId);
            return (
              c.projectId !== run.projectId ||
              c.status !== 'accepted' ||
              c.revision !== s.revision ||
              c.number !== s.number
            );
          })
        )
          throw new DomainError('INVALID_EVIDENCE', '摘要来源不是当前正式稿');
        const prior = this.all<StoryDigest>(
          'SELECT payload FROM digests WHERE project_id=? AND key=?',
          run.projectId,
          input.key,
        )[0];
        const digest: StoryDigest = {
          ...input,
          id: prior?.id ?? randomUUID(),
          projectId: run.projectId,
          valid: true,
          createdAt: now(),
        };
        this.db
          .prepare(
            'INSERT INTO digests VALUES (?,?,?,?) ON CONFLICT(project_id,key) DO UPDATE SET payload=excluded.payload',
          )
          .run(digest.id, run.projectId, digest.key, json(digest));
        this.event(run.projectId, runId, 'digest.saved', {
          id: digest.id,
          scope: digest.scope,
          chapters: digest.sources.length,
        });
        return digest;
      })
      .immediate();
  }
  saveChapter(
    projectId: string,
    input: { title: string; text: string; volume: number },
    expectedRevision: number,
    id?: string,
    reason = '作者编辑',
  ): Chapter {
    input = chapterInputSchema.parse(input);
    return this.db
      .transaction(() => {
        this.bump(projectId, expectedRevision);
        const prev = id ? this.getChapter(id) : null;
        if (prev && prev.projectId !== projectId) throw new DomainError('NOT_FOUND', '章节不属于该作品', 404);
        const c: Chapter = {
          ...input,
          id: id ?? randomUUID(),
          projectId,
          number: prev?.number ?? (this.chapters(projectId).at(-1)?.number ?? 0) + 1,
          revision: (prev?.revision ?? 0) + 1,
          status: 'draft',
          chars: countChars(input.text),
          createdAt: prev?.createdAt ?? now(),
          updatedAt: now(),
        };
        this.writeChapter(c, reason);
        this.invalidate(projectId, c.number, c.id, `第 ${c.number} 章修订，后续状态与摘要待重新核对`);
        this.event(projectId, null, 'chapter.updated', { id: c.id });
        return c;
      })
      .immediate();
  }
  importChapters(
    projectId: string,
    inputs: { title: string; text: string; volume: number }[],
    expectedRevision: number,
  ): Chapter[] {
    const chapters = z.array(chapterInputSchema).min(1).parse(inputs);
    return this.db
      .transaction(() => {
        if (this.getProject(projectId).revision !== expectedRevision)
          throw new DomainError('REVISION_CONFLICT', '导入期间作品已修改，请重试', 409);
        // 批量导入一次只提升一个项目版本，避免逐章重复加载整张章节表。
        this.bump(projectId, expectedRevision);
        const start = (this.chapters(projectId).at(-1)?.number ?? 0) + 1;
        return chapters.map((input, i) => {
          const c: Chapter = {
            ...input,
            id: randomUUID(),
            projectId,
            number: start + i,
            revision: 1,
            status: 'draft',
            chars: countChars(input.text),
            createdAt: now(),
            updatedAt: now(),
          };
          this.writeChapter(c, '文件导入');
          this.db
            .prepare(
              'INSERT INTO impacts VALUES (?,?,?,0) ON CONFLICT(chapter_id,source_id) DO UPDATE SET reason=excluded.reason,resolved=0',
            )
            .run(c.id, c.id, `第 ${c.number} 章导入，后续状态与摘要待重新核对`);
          this.event(projectId, null, 'chapter.updated', { id: c.id });
          return c;
        });
      })
      .immediate();
  }
  revisions(chapterId: string): ChapterRevision[] {
    return this.all('SELECT payload FROM revisions WHERE chapter_id=? ORDER BY revision DESC', chapterId);
  }
  facts(projectId: string, before = Number.MAX_SAFE_INTEGER): MemoryFact[] {
    return this.all<MemoryFact>(
      'SELECT payload FROM memories WHERE project_id=? AND valid=1 AND chapter_number<? ORDER BY chapter_number',
      projectId,
      before,
    );
  }
  impacts(projectId: string) {
    return (
      this.db
        .prepare(
          'SELECT i.*,c.payload FROM impacts i JOIN chapters c ON c.id=i.chapter_id WHERE c.project_id=? AND i.resolved=0 ORDER BY c.number',
        )
        .all(projectId) as Row[]
    ).map((r) => ({
      chapterId: String(r.chapter_id),
      title: (JSON.parse(String(r.payload)) as Chapter).title,
      reason: String(r.reason),
      resolved: Boolean(r.resolved),
    }));
  }
  private index(id: string, projectId: string, source: string, text: string) {
    this.db.prepare('DELETE FROM search_index WHERE id=?').run(id);
    this.db.prepare('INSERT INTO search_index VALUES (?,?,?,?)').run(id, projectId, source, searchable(text));
  }
  search(projectId: string, query: string, before = Number.MAX_SAFE_INTEGER, limit = 24): Evidence[] {
    const terms = searchable(query).split(' ').filter(Boolean).slice(0, 80);
    if (!terms.length) return [];
    const rows = this.db
      .prepare(
        'SELECT id,source,bm25(search_index) AS rank FROM search_index WHERE search_index MATCH ? AND project_id=? ORDER BY rank LIMIT ?',
      )
      .all(terms.map((t) => '"' + t.replaceAll('"', '""') + '"').join(' OR '), projectId, limit * 4) as Row[];
    const result: Evidence[] = [];
    for (const row of rows) {
      if (row.source === 'entity') {
        const e = this.one<Entity>('SELECT payload FROM entities WHERE id=?', String(row.id));
        if (
          e.status !== 'canon' ||
          e.narrativeFrom >= before ||
          (e.narrativeTo !== null && e.narrativeTo < before - 1)
        )
          continue;
        result.push({
          id: e.id,
          source: 'entity',
          title: e.name,
          text: json(e),
          revision: e.revision,
          score: -Number(row.rank),
        });
      } else {
        const c = this.getChapter(String(row.id));
        if (c.status !== 'accepted' || c.number >= before) continue;
        const summary = this.db
          .prepare('SELECT summary FROM summaries WHERE chapter_id=? AND revision=?')
          .get(c.id, c.revision) as Row | undefined;
        const paragraphs = c.text.split(/\n+/).filter(Boolean);
        const picked = paragraphs
          .map((p, i) => ({ p, i, score: terms.filter((t) => p.includes(t)).length }))
          .sort((a, b) => b.score - a.score)
          .slice(0, 3)
          .sort((a, b) => a.i - b.i);
        result.push({
          id: c.id,
          source: 'chapter',
          chapterId: c.id,
          title: `第${c.number}章 ${c.title}`,
          text: (summary ? `可追溯摘要：${summary.summary}\n` : '') + picked.map((x) => x.p).join('\n'),
          revision: c.revision,
          score: -Number(row.rank),
        });
      }
      if (result.length >= limit) break;
    }
    return result;
  }
  createRun(projectId: string, input: RunInput, key: string): Run {
    return this.db
      .transaction(() => {
        const existing = this.all<Run>(
          'SELECT payload FROM runs WHERE project_id=? AND key=?',
          projectId,
          key,
        )[0];
        if (existing) {
          if (
            json({
              kind: existing.kind,
              instruction: existing.instruction,
              chapterId: existing.chapterId,
              volume: existing.volume,
              count: existing.count,
            }) !== json(input)
          )
            throw new DomainError('IDEMPOTENCY_CONFLICT', '同一幂等键不能用于不同任务', 409);
          return existing;
        }
        const p = this.getProject(projectId);
        if (input.chapterId && this.getChapter(input.chapterId).projectId !== projectId)
          throw new DomainError('NOT_FOUND', '章节不属于该作品', 404);
        const r: Run = {
          ...input,
          id: randomUUID(),
          projectId,
          status: 'queued',
          step: '等待执行',
          progress: 0,
          baseRevision: p.revision,
          checkpoint: {},
          result: null,
          error: null,
          owner: null,
          leaseUntil: null,
          request: null,
          createdAt: now(),
          updatedAt: now(),
        };
        this.db
          .prepare('INSERT INTO runs VALUES (?,?,?,?,?,?,?)')
          .run(r.id, projectId, key, r.status, null, null, json(r));
        this.event(projectId, r.id, 'run.created', r);
        return r;
      })
      .immediate();
  }
  getRun(id: string): Run {
    return this.one('SELECT payload FROM runs WHERE id=?', id);
  }
  runs(projectId: string): Run[] {
    return this.all('SELECT payload FROM runs WHERE project_id=? ORDER BY rowid DESC LIMIT 100', projectId);
  }
  private putRun(r: Run) {
    r.updatedAt = now();
    this.db
      .prepare('UPDATE runs SET status=?,owner=?,lease_until=?,payload=? WHERE id=?')
      .run(r.status, r.owner, r.leaseUntil, json(r), r.id);
  }
  claim(owner: string, leaseMs: number): Run | null {
    return this.db
      .transaction(() => {
        const active = this.all<Run>('SELECT payload FROM runs WHERE status=?', 'running');
        for (const r of active) {
          if ((r.leaseUntil ?? 0) > Date.now()) return null;
          this.putRun({
            ...r,
            status: r.request === 'cancel' ? 'cancelled' : 'paused',
            owner: null,
            leaseUntil: null,
            request: null,
            error: 'Worker 租约过期；检查点已保留，请恢复任务',
          });
          this.event(r.projectId, r.id, 'run.recovered', { message: '上次运行中断，等待恢复' });
        }
        const next = this.all<Run>(
          'SELECT payload FROM runs WHERE status=? ORDER BY rowid LIMIT 1',
          'queued',
        )[0];
        if (!next) return null;
        // Queued jobs bind to current state when first admitted, not when clicked.
        const r = {
          ...next,
          status: 'running' as const,
          owner,
          leaseUntil: Date.now() + leaseMs,
          baseRevision: Object.keys(next.checkpoint).length
            ? next.baseRevision
            : this.getProject(next.projectId).revision,
        };
        this.putRun(r);
        this.event(r.projectId, r.id, 'run.started', { step: r.step });
        return r;
      })
      .immediate();
  }
  private owned(id: string, owner: string): Run {
    const r = this.getRun(id);
    if (r.owner !== owner || r.status !== 'running' || (r.leaseUntil ?? 0) < Date.now())
      throw new DomainError('LEASE_LOST', '当前 Worker 已失去任务所有权', 409);
    return r;
  }
  heartbeat(id: string, owner: string, leaseMs: number): boolean {
    return this.db
      .transaction(() => {
        try {
          const r = this.owned(id, owner);
          r.leaseUntil = Date.now() + leaseMs;
          this.putRun(r);
          return true;
        } catch {
          return false;
        }
      })
      .immediate();
  }
  patchRun(id: string, owner: string, patch: Partial<Run>): Run {
    return this.db
      .transaction(() => {
        const r = { ...this.owned(id, owner), ...patch };
        if (r.status !== 'running') {
          r.owner = null;
          r.leaseUntil = null;
        }
        this.putRun(r);
        this.event(r.projectId, id, 'run.updated', {
          status: r.status,
          step: r.step,
          progress: r.progress,
          error: r.error,
        });
        return r;
      })
      .immediate();
  }
  controlRun(id: string, action: 'pause' | 'resume' | 'cancel'): Run {
    return this.db
      .transaction(() => {
        const r = this.getRun(id);
        if (['completed', 'cancelled'].includes(r.status))
          throw new DomainError('TERMINAL_RUN', '任务已经结束', 409);
        if (action === 'resume') {
          if (!['paused', 'failed'].includes(r.status))
            throw new DomainError('INVALID_TRANSITION', '只有暂停或失败的任务可以恢复', 409);
          if (this.getProject(r.projectId).revision !== r.baseRevision)
            throw new DomainError(
              'REVISION_CONFLICT',
              '资料已改变，请从当前版本新建任务；旧检查点保留供比较',
              409,
            );
          r.status = 'queued';
          r.error = null;
          r.request = null;
        } else if (r.status === 'running') r.request = action;
        else {
          r.status = action === 'cancel' ? 'cancelled' : 'paused';
          r.request = null;
        }
        this.putRun(r);
        this.event(r.projectId, id, 'run.control', { action });
        return r;
      })
      .immediate();
  }
  completeBlueprint(id: string, owner: string, outline: BookOutline) {
    this.patchRun(id, owner, {
      status: 'awaiting_approval',
      step: '确认全书蓝图',
      result: blueprintSchema.parse(outline),
    });
  }
  completeVolume(id: string, owner: string, volume: VolumePlan) {
    this.patchRun(id, owner, {
      status: 'awaiting_approval',
      step: '确认卷纲',
      result: volumeSchema.parse(volume),
    });
  }
  approveRun(id: string, revision: number): Run {
    return this.db
      .transaction(() => {
        const r = this.getRun(id);
        if (r.status !== 'awaiting_approval')
          throw new DomainError('INVALID_TRANSITION', '该任务无需确认', 409);
        if (r.baseRevision !== revision)
          throw new DomainError('REVISION_CONFLICT', '生成方案基于旧资料，请重新规划', 409);
        const p = this.bump(r.projectId, revision);
        if (r.kind === 'blueprint') {
          const outline = blueprintSchema.parse(r.result);
          p.outline = outline;
          p.approved = true;
          p.volumes = {};
          if (this.chapters(p.id).length)
            this.invalidate(p.id, 0, 'book-outline', '全书蓝图已重订，请复核已有章节');
          const existing = this.entities(p.id);
          const cards: EntityInput[] = [
            ...outline.characters.map((c) =>
              entityInputSchema.parse({
                kind: 'character',
                name: c.name,
                description: c.role,
                fields: {
                  欲望: c.desire,
                  弱点: c.weakness,
                  说话方式: c.voice,
                  人物弧: c.arc,
                  秘密: c.secret,
                },
              }),
            ),
            ...outline.worldRules.map((w) =>
              entityInputSchema.parse({
                kind: 'rule',
                name: w.name,
                fields: { 触发条件: w.condition, 效果: w.effect, 硬限制: w.limit, 代价: w.cost },
              }),
            ),
          ];
          for (const card of cards)
            if (!existing.some((e) => e.kind === card.kind && e.name === card.name)) {
              const e: Entity = {
                ...card,
                id: randomUUID(),
                projectId: p.id,
                revision: 1,
                createdAt: now(),
                updatedAt: now(),
              };
              this.db.prepare('INSERT INTO entities VALUES (?,?,?)').run(e.id, p.id, json(e));
              this.index(e.id, p.id, 'entity', json(e));
            }
        } else if (r.kind === 'volume') {
          const volume = volumeSchema.parse(r.result);
          p.volumes[String(volume.number)] = { ...volume, approved: true };
        } else throw new DomainError('INVALID_APPROVAL', '任务没有可确认的规划');
        this.putProject(p);
        r.baseRevision = p.revision;
        r.status = 'completed';
        r.step = '已确认';
        this.putRun(r);
        this.event(p.id, id, 'run.approved', { revision: p.revision });
        return r;
      })
      .immediate();
  }
  reviseProposal(id: string, revision: number, input: unknown): Run {
    return this.db
      .transaction(() => {
        const r = this.getRun(id);
        if (r.status !== 'awaiting_approval' || !['blueprint', 'volume'].includes(r.kind))
          throw new DomainError('INVALID_TRANSITION', '只能调整待确认方案', 409);
        if (r.baseRevision !== revision || this.getProject(r.projectId).revision !== revision)
          throw new DomainError('REVISION_CONFLICT', '方案来源已过期，请重新规划', 409);
        const result = r.kind === 'blueprint' ? blueprintSchema.parse(input) : volumeSchema.parse(input);
        if ('volumes' in result && result.volumes.some((v, i) => v.number !== i + 1))
          throw new DomainError('INVALID_PLAN', '卷序号必须从1连续编号');
        if ('number' in result && result.number !== r.volume)
          throw new DomainError('INVALID_VOLUME', '不能更改当前方案的卷号');
        this.event(r.projectId, r.id, 'proposal.revised', { before: r.result, after: result });
        r.result = result;
        this.putRun(r);
        return r;
      })
      .immediate();
  }
  saveDraft(id: string, owner: string, title: string, text: string, chapterId?: string): Chapter {
    return this.db
      .transaction(() => {
        const r = this.owned(id, owner);
        const chapter = this.saveChapter(
          r.projectId,
          { title, text, volume: r.volume },
          r.baseRevision,
          chapterId,
          '任务草稿',
        );
        r.baseRevision = this.getProject(r.projectId).revision;
        this.putRun(r);
        return chapter;
      })
      .immediate();
  }
  commitGenerated(
    id: string,
    owner: string,
    expected: number,
    title: string,
    text: string,
    review: Review,
    facts: ExtractedFact[],
    summary: string,
    chapterId?: string,
  ): Chapter {
    return this.db
      .transaction(() => {
        const r = this.owned(id, owner);
        if (r.request === 'cancel') throw new DomainError('CANCELLED', '已取消');
        const c = this.saveChapter(
          r.projectId,
          { title, text, volume: r.volume },
          expected,
          chapterId,
          '生成并审校',
        );
        return this.accept(r, c, review, facts, summary);
      })
      .immediate();
  }
  commitChapter(
    id: string,
    owner: string,
    expected: number,
    chapterId: string,
    review: Review,
    facts: ExtractedFact[],
    summary: string,
  ): Chapter {
    return this.db
      .transaction(() => {
        const r = this.owned(id, owner);
        if (r.request === 'cancel') throw new DomainError('CANCELLED', '已取消');
        const c = this.getChapter(chapterId);
        if (c.projectId !== r.projectId) throw new DomainError('NOT_FOUND', '章节不属于该作品', 404);
        this.bump(r.projectId, expected);
        return this.accept(r, c, review, facts, summary);
      })
      .immediate();
  }
  private accept(r: Run, c: Chapter, review: Review, extracted: ExtractedFact[], summary: string): Chapter {
    if (review.findings.some((f) => f.severity !== 'minor'))
      throw new DomainError('QUALITY_GATE', '存在未解决的重大问题，章节不能正式收录');
    const facts = verifyFacts(c.text, extracted);
    if (this.chapters(c.projectId).some((other) => other.number < c.number && other.status !== 'accepted'))
      throw new DomainError('PREVIOUS_CHAPTER_PENDING', '请先完成前序章节复核和记忆更新');
    this.db.prepare('UPDATE memories SET valid=0 WHERE chapter_id=?').run(c.id);
    for (const fact of facts) {
      const memory: MemoryFact = {
        ...fact,
        id: randomUUID(),
        projectId: c.projectId,
        chapterId: c.id,
        chapterRevision: c.revision,
        chapterNumber: c.number,
        valid: true,
        createdAt: now(),
      };
      this.db
        .prepare('INSERT INTO memories VALUES (?,?,?,?,?,?,?)')
        .run(memory.id, c.projectId, c.id, c.revision, c.number, 1, json(memory));
    }
    this.db
      .prepare(
        'INSERT INTO summaries VALUES (?,?,?) ON CONFLICT(chapter_id) DO UPDATE SET revision=excluded.revision,summary=excluded.summary',
      )
      .run(c.id, c.revision, summary);
    c.status = 'accepted';
    this.db.prepare('UPDATE chapters SET status=?,payload=? WHERE id=?').run(c.status, json(c), c.id);
    this.db.prepare('UPDATE impacts SET resolved=1 WHERE chapter_id=?').run(c.id);
    r.baseRevision = this.getProject(c.projectId).revision;
    r.progress += ['write', 'ingest'].includes(r.kind) ? 1 : 0;
    r.checkpoint = { committedChapter: c.id, committedProgress: r.progress };
    this.putRun(r);
    this.event(c.projectId, r.id, 'chapter.accepted', { chapterId: c.id, chars: c.chars, review });
    return c;
  }
  events(projectId: string, after = 0): RunEvent[] {
    return (
      this.db
        .prepare('SELECT * FROM events WHERE project_id=? AND id>? ORDER BY id LIMIT 500')
        .all(projectId, after) as Row[]
    ).map((r) => ({
      id: Number(r.id),
      projectId: String(r.project_id),
      runId: r.run_id ? String(r.run_id) : null,
      type: String(r.type),
      data: JSON.parse(String(r.data)),
      createdAt: String(r.created_at),
    }));
  }
  latestEventId(projectId: string): number {
    return Number(
      (this.db.prepare('SELECT MAX(id) AS id FROM events WHERE project_id=?').get(projectId) as Row).id ?? 0,
    );
  }
  event(projectId: string, runId: string | null, type: string, data: unknown) {
    this.db
      .prepare('INSERT INTO events(project_id,run_id,type,data,created_at) VALUES (?,?,?,?,?)')
      .run(projectId, runId, type, json(data), now());
  }
  saveTrace(
    runId: string,
    manifest: ContextManifest,
    messages: Message[],
    stats?: Record<string, unknown>,
  ): string {
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO traces VALUES (?,?,?)')
      .run(id, runId, json({ id, manifest, messages, stats, createdAt: now() }));
    return id;
  }
  traces(runId: string): unknown[] {
    return this.all('SELECT payload FROM traces WHERE run_id=? ORDER BY rowid', runId);
  }
  vectors(projectId: string, identity: string, before = Number.MAX_SAFE_INTEGER) {
    const rows = this.db
      .prepare(
        "SELECT v.* FROM vectors v JOIN chapters c ON c.id=v.chapter_id WHERE v.project_id=? AND v.identity=? AND v.revision=c.revision AND c.status='accepted' AND c.number<?",
      )
      .all(projectId, identity, before) as (Row & { vector: Buffer })[];
    return rows.map((r) => ({
      id: String(r.id),
      chapterId: String(r.chapter_id),
      revision: Number(r.revision),
      text: String(r.text),
      vector: Array.from(
        new Float32Array(
          r.vector.buffer.slice(r.vector.byteOffset, r.vector.byteOffset + r.vector.byteLength),
        ),
      ),
    }));
  }
  putVector(
    projectId: string,
    chapterId: string,
    revision: number,
    text: string,
    vector: number[],
    identity: string,
  ) {
    const c = this.getChapter(chapterId);
    if (c.projectId !== projectId || c.revision !== revision || c.status !== 'accepted')
      throw new DomainError('STALE_INDEX', '索引来源已过期', 409);
    if (!vector.length || vector.some((n) => !Number.isFinite(n)))
      throw new DomainError('INVALID_VECTOR', '向量输出无效');
    const id = createHash('sha256').update([chapterId, revision, identity, text].join('\0')).digest('hex');
    this.db
      .prepare('INSERT OR REPLACE INTO vectors VALUES (?,?,?,?,?,?,?)')
      .run(id, projectId, chapterId, revision, identity, text, Buffer.from(new Float32Array(vector).buffer));
  }
  async backup(destination: string) {
    await this.db.backup(destination);
  }
  exportProject(id: string) {
    const project = this.getProject(id);
    const chapters = this.chapters(id);
    return {
      format: 'novel-studio',
      version: 1,
      exportedAt: now(),
      project,
      entities: this.entities(id),
      chapters,
      revisions: chapters.flatMap((c) => this.revisions(c.id)),
      memories: this.all<MemoryFact>('SELECT payload FROM memories WHERE project_id=? AND valid=1', id),
      summaries: this.db
        .prepare('SELECT s.* FROM summaries s JOIN chapters c ON s.chapter_id=c.id WHERE c.project_id=?')
        .all(id),
    };
  }
  importProject(data: unknown): Project {
    const chapterSchema = z.object({
      id: z.string(),
      number: z.number().int().positive(),
      revision: z.number().int().positive(),
      status: z.enum(['draft', 'accepted', 'stale']),
      title: z.string(),
      text: z.string(),
      volume: z.number().int().positive(),
      createdAt: z.string(),
      updatedAt: z.string(),
    });
    const bundle = z
      .object({
        format: z.literal('novel-studio'),
        version: z.literal(1),
        project: projectInputSchema.extend({
          outline: blueprintSchema.nullable(),
          approved: z.boolean(),
          volumes: z.record(z.string(), volumeSchema.extend({ approved: z.boolean() })),
        }),
        entities: z.array(
          entityInputSchema.extend({
            id: z.string(),
            revision: z.number().int().positive(),
            createdAt: z.string(),
            updatedAt: z.string(),
          }),
        ),
        chapters: z.array(chapterSchema),
        revisions: z.array(
          z.object({
            chapterId: z.string(),
            revision: z.number().int().positive(),
            title: z.string(),
            text: z.string(),
            reason: z.string(),
            createdAt: z.string(),
          }),
        ),
        memories: z.array(
          z.object({
            chapterId: z.string(),
            chapterRevision: z.number().int().positive(),
            chapterNumber: z.number().int().positive(),
            subject: z.string(),
            predicate: z.string(),
            value: z.string(),
            kind: z.enum(['fact', 'belief', 'knowledge', 'promise', 'relationship', 'state', 'summary']),
            holder: z.string().nullable(),
            storyTime: z.string(),
            quote: z.string().min(1),
          }),
        ),
        summaries: z.array(
          z.object({ chapter_id: z.string(), revision: z.number().int().positive(), summary: z.string() }),
        ),
      })
      .parse(data);
    return this.db
      .transaction(() => {
        const p = this.createProject(bundle.project);
        p.outline = bundle.project.outline;
        p.approved = bundle.project.approved;
        p.volumes = bundle.project.volumes;
        this.putProject(p);
        const entityIds = new Map(bundle.entities.map((e) => [e.id, randomUUID()]));
        for (const old of bundle.entities) {
          const e: Entity = {
            ...old,
            id: entityIds.get(old.id)!,
            projectId: p.id,
            fromEntityId: old.fromEntityId ? (entityIds.get(old.fromEntityId) ?? null) : null,
            toEntityId: old.toEntityId ? (entityIds.get(old.toEntityId) ?? null) : null,
          };
          this.db.prepare('INSERT INTO entities VALUES (?,?,?)').run(e.id, p.id, json(e));
          this.index(e.id, p.id, 'entity', json(e));
        }
        const chapterIds = new Map(bundle.chapters.map((c) => [c.id, randomUUID()]));
        for (const old of [...bundle.chapters].sort((a, b) => a.number - b.number)) {
          const c: Chapter = {
            ...old,
            id: chapterIds.get(old.id)!,
            projectId: p.id,
            chars: countChars(old.text),
          };
          this.db
            .prepare('INSERT INTO chapters VALUES (?,?,?,?,?,?)')
            .run(c.id, p.id, c.number, c.revision, c.status, json(c));
          this.index(c.id, p.id, 'chapter', c.title + '\n' + c.text);
          const history = bundle.revisions.filter((r) => r.chapterId === old.id);
          if (!history.some((r) => r.revision === c.revision && r.text === c.text && r.title === c.title))
            throw new DomainError('INVALID_BACKUP', '当前正文与历史版本不一致');
          for (const source of history) {
            const revision = { ...source, id: randomUUID(), chapterId: c.id };
            this.db
              .prepare('INSERT INTO revisions VALUES (?,?,?,?)')
              .run(revision.id, c.id, revision.revision, json(revision));
          }
          if (c.status === 'stale')
            this.db.prepare('INSERT INTO impacts VALUES (?,?,?,0)').run(c.id, 'import', '导入前已标记待复核');
        }
        for (const old of bundle.memories) {
          const chapterId = chapterIds.get(old.chapterId);
          if (!chapterId) throw new DomainError('INVALID_BACKUP', '记忆的来源章节不存在');
          const c = this.getChapter(chapterId);
          if (c.revision !== old.chapterRevision || c.number !== old.chapterNumber || c.status !== 'accepted')
            throw new DomainError('INVALID_BACKUP', '有效记忆指向了过期正文');
          const verified = verifyFacts(c.text, [old])[0]!;
          const m: MemoryFact = {
            ...verified,
            id: randomUUID(),
            projectId: p.id,
            chapterId,
            chapterRevision: c.revision,
            chapterNumber: c.number,
            valid: true,
            createdAt: now(),
          };
          this.db
            .prepare('INSERT INTO memories VALUES (?,?,?,?,?,?,?)')
            .run(m.id, p.id, c.id, c.revision, c.number, 1, json(m));
        }
        for (const old of bundle.summaries) {
          const chapterId = chapterIds.get(old.chapter_id);
          if (chapterId && this.getChapter(chapterId).revision === old.revision)
            this.db.prepare('INSERT INTO summaries VALUES (?,?,?)').run(chapterId, old.revision, old.summary);
        }
        this.event(p.id, null, 'project.imported', {
          message: '作品资料、正文历史与有效记忆已恢复为独立副本；语义索引可重建',
        });
        return p;
      })
      .immediate();
  }
  close() {
    this.db.close();
  }
}
