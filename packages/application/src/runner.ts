import { z } from 'zod';
import {
  DomainError,
  blueprintSchema,
  volumeSchema,
  scenePlanSchema,
  reviewSchema,
  extractionSchema,
  intentSchema,
  deterministicReview,
  verifyFacts,
  countChars,
  stripJsonFence,
  digestContentSchema,
  auditSchema,
  repairSchema,
  applyTextEdits,
  reviewVerificationSchema,
  type Evidence,
  type Project,
  type Review,
  type Run,
  type ScenePlan,
} from '../../domain/src/index.ts';
import type { Embeddings, LanguageModel, StoryStore } from './ports.ts';
import { buildContext, retrieve, type ContextConfig } from './context.ts';
import type { taskPrompts } from '../../prompts/src/index.ts';
import { PROMPT_VERSION } from '../../prompts/src/index.ts';
import { DigestBuilder } from './digests.ts';
import { withSignal } from './cancellation.ts';
import { entityEvidence, memoryEvidence } from './evidence.ts';

export type RunnerConfig = {
  context: ContextConfig;
  temperature: number;
  analysisTemperature: number;
  timeoutMs: number;
  retries: number;
  revisionRounds: number;
  embeddingChunkChars: number;
  summaryBatchSize: number;
};
type ChapterCheckpoint = {
  plan?: ScenePlan;
  title?: string;
  text?: string;
  sceneIndex?: number;
  review?: Review;
  extraction?: z.infer<typeof extractionSchema>;
  revisionRound?: number;
  committedChapter?: string;
  committedProgress?: number;
};
export class NovelRunner {
  constructor(
    private store: StoryStore,
    private model: LanguageModel,
    private embeddings: Embeddings | undefined,
    private config: RunnerConfig,
  ) {}
  async execute(id: string, owner: string, signal: AbortSignal): Promise<void> {
    const r = this.store.getRun(id);
    try {
      this.store.event(r.projectId, id, 'run.configuration', {
        promptVersion: PROMPT_VERSION,
        policy: this.config,
      });
      if (r.kind === 'blueprint') {
        const output = await this.call(r, owner, 'blueprint', r.instruction, '', blueprintSchema, signal);
        if (output.volumes.some((v, i) => v.number !== i + 1))
          throw new DomainError('INVALID_PLAN', '卷序号必须从1连续编号');
        this.store.completeBlueprint(id, owner, output);
        return;
      }
      if (r.kind === 'volume') {
        const p = this.store.getProject(r.projectId);
        if (!p.approved || !p.outline) throw new DomainError('APPROVAL_REQUIRED', '请先确认全书蓝图');
        const volume = p.outline.volumes.find((v) => v.number === r.volume);
        if (!volume) throw new DomainError('INVALID_VOLUME', '该卷不在已确认全书蓝图中');
        const output = await this.call(
          r,
          owner,
          'volume',
          `当前第${r.volume}卷。${r.instruction}`,
          JSON.stringify({
            volume,
            book: { theme: p.outline.theme, ending: p.outline.ending },
            suggestedChapterCount: Math.max(
              1,
              Math.round(p.targetChars / p.chapterTarget / p.outline.volumes.length),
            ),
          }),
          volumeSchema,
          signal,
        );
        if (output.number !== r.volume) throw new DomainError('INVALID_VOLUME', '生成卷号与请求不一致');
        this.store.completeVolume(id, owner, { ...output, approved: false });
        return;
      }
      if (r.kind === 'intent') {
        const selected = r.chapterId ? this.store.getChapter(r.chapterId) : null;
        const output = await this.call(
          r,
          owner,
          'intent',
          r.instruction,
          selected ? `当前选中：${selected.title}\n${selected.text}` : '',
          intentSchema,
          signal,
        );
        this.store.patchRun(id, owner, { status: 'completed', result: output, step: '意图解析完成' });
        return;
      }
      if (r.kind === 'reindex') {
        if (!this.embeddings) throw new DomainError('EMBEDDING_UNAVAILABLE', '请先配置 Embedding 模型');
        for (const chapter of this.store.chapters(r.projectId).filter((c) => c.status === 'accepted')) {
          this.checkpointPause(id, owner, signal);
          await this.index(r, chapter.id);
          this.store.patchRun(id, owner, {
            progress: this.store.getRun(id).progress + 1,
            step: `已索引第${chapter.number}章`,
          });
        }
        this.store.patchRun(id, owner, { status: 'completed', step: '语义索引重建完成' });
        return;
      }
      if (r.kind === 'write') {
        await this.writeBook(r, owner, signal);
        return;
      }
      if (r.kind === 'ingest') {
        while (this.store.getRun(id).progress < r.count) {
          this.checkpointPause(id, owner, signal);
          const chapter = this.store.chapters(r.projectId).find((c) => c.status !== 'accepted');
          if (!chapter) break;
          const current = { ...this.store.getRun(id), chapterId: chapter.id };
          const cp =
            current.checkpoint.chapterId === chapter.id ? (current.checkpoint as ChapterCheckpoint) : {};
          const review = cp.review ?? (await this.review(current, owner, chapter.text, signal));
          this.store.patchRun(id, owner, { checkpoint: { chapterId: chapter.id, review }, result: review });
          if (review.findings.some((f) => f.severity !== 'minor'))
            throw new DomainError('QUALITY_GATE', `第${chapter.number}章需要作者复核；此前已收录章节保留`);
          const extraction = await this.call(
            current,
            owner,
            'extract',
            '只收录当前章节已经发生的事实',
            chapter.text,
            extractionSchema,
            signal,
            (value) => {
              verifyFacts(chapter.text, value.facts);
            },
          );
          this.checkpointPause(id, owner, signal);
          this.store.commitChapter(
            id,
            owner,
            this.store.getRun(id).baseRevision,
            chapter.id,
            review,
            extraction.facts,
            extraction.summary,
          );
          await this.index(current, chapter.id).catch((e) => this.indexWarning(current, e));
        }
        this.store.patchRun(id, owner, { status: 'completed', step: '本次顺序审校收录已完成' });
        return;
      }
      if (r.kind === 'summarize' || r.kind === 'audit') {
        const hierarchy = await this.summarize(r, owner, signal);
        if (r.kind === 'summarize') {
          this.store.patchRun(id, owner, {
            status: 'completed',
            step: '卷级与全书摘要已更新',
            result: { summary: hierarchy.book.summary, coveredChapters: hierarchy.book.sources.length },
          });
          return;
        }
        // Audit every bounded chapter group plus the book ending, not one unbounded prompt.
        const selectedBlocks = hierarchy.nodes.filter((d) => d.scope === 'volume' && d.level === 0);
        const audited = {
          ...(this.store.getRun(id).checkpoint.audited as
            Record<string, z.infer<typeof auditSchema>> | undefined),
        };
        for (const block of [...selectedBlocks, hierarchy.book]) {
          this.checkpointPause(id, owner, signal);
          if (audited[block.id]) continue;
          const sources = block.scope === 'book' ? [block.sources[0]!, block.sources.at(-1)!] : block.sources;
          const p = this.store.getProject(r.projectId);
          const result = await this.call(
            r,
            owner,
            'audit',
            r.instruction,
            JSON.stringify({
              summary: block.summary,
              stateChanges: block.stateChanges,
              openPromises: block.openPromises,
              sources,
              plannedEnding: p.outline?.ending,
              theme: p.outline?.theme,
              scope: block.scope,
            }),
            auditSchema,
            signal,
            (value) => {
              if (
                value.findings.some((f) =>
                  f.sourceChapterIds.some((ref) => !sources.some((s) => s.chapterId === ref)),
                )
              )
                throw new DomainError('INVALID_EVIDENCE', '审计引用必须属于本组提供的来源章节');
            },
          );
          audited[block.id] = result;
          this.store.patchRun(id, owner, { checkpoint: { audited }, progress: Object.keys(audited).length });
        }
        this.store.patchRun(id, owner, {
          status: 'completed',
          step: '全书收束候选审计完成',
          result: {
            scope: '摘要层审计，待回查原文；不代表文学质量通过',
            coveredChapters: hierarchy.book.sources.length,
            sections: Object.values(audited),
          },
        });
        return;
      }
      if (!r.chapterId) throw new DomainError('CHAPTER_REQUIRED', '请先选择章节');
      const chapter = this.store.getChapter(r.chapterId);
      if (r.kind === 'review') {
        const review = await this.review(r, owner, chapter.text, signal);
        this.store.patchRun(id, owner, { status: 'completed', step: '审校完成', result: review });
        return;
      }
      if (r.kind === 'extract') {
        if (r.checkpoint.committedChapter === chapter.id) {
          this.store.patchRun(id, owner, { status: 'completed', step: '从已提交检查点恢复完成' });
          return;
        }
        const review = await this.review(r, owner, chapter.text, signal);
        this.store.patchRun(id, owner, { result: review });
        if (review.findings.some((f) => f.severity !== 'minor'))
          throw new DomainError('QUALITY_GATE', '审校发现重大问题，请修订后再收录');
        const extraction = await this.call(
          r,
          owner,
          'extract',
          '提取当前章节状态',
          chapter.text,
          extractionSchema,
          signal,
          (value) => {
            verifyFacts(chapter.text, value.facts);
          },
        );
        verifyFacts(chapter.text, extraction.facts);
        this.store.commitChapter(
          id,
          owner,
          this.store.getRun(id).baseRevision,
          chapter.id,
          review,
          extraction.facts,
          extraction.summary,
        );
        await this.index(r, chapter.id).catch((e) => this.indexWarning(r, e));
        this.store.patchRun(id, owner, {
          status: 'completed',
          step: '章节已收录并更新记忆',
          result: { review, summary: extraction.summary },
        });
        return;
      }
      const task = r.kind === 'polish' ? 'polish' : 'rewrite';
      const saved = this.store.getRun(id).checkpoint as ChapterCheckpoint;
      const text = saved.text ?? (await this.callText(r, owner, task, r.instruction, chapter.text, signal));
      this.store.patchRun(id, owner, { checkpoint: { text, title: chapter.title } });
      const review = await this.review(r, owner, text, signal);
      this.store.patchRun(id, owner, {
        result: { text, review },
        checkpoint: { text, title: chapter.title, review },
      });
      // Rewrites always remain reviewable proposals; source text is changed only by the author's save.
      this.store.patchRun(id, owner, { status: 'completed', step: '修订建议已生成，原稿保留' });
    } catch (error) {
      const current = this.store.getRun(id);
      if (current.owner !== owner || current.status !== 'running') return;
      const cancelled = current.request === 'cancel';
      const paused = error instanceof DomainError && error.code === 'PAUSED';
      this.store.patchRun(id, owner, {
        status: cancelled ? 'cancelled' : paused || signal.aborted ? 'paused' : 'failed',
        request: null,
        error: cancelled ? null : error instanceof Error ? error.message : String(error),
        step: cancelled ? '已取消；检查点保留' : paused ? '已在检查点暂停' : '需要处理',
      });
    }
  }
  private checkpointPause(id: string, owner: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const r = this.store.getRun(id);
    if (r.request === 'cancel') throw new DomainError('CANCELLED', '已取消');
    if (r.request === 'pause') throw new DomainError('PAUSED', '已暂停');
    if (this.store.getProject(r.projectId).revision !== r.baseRevision)
      throw new DomainError('REVISION_CONFLICT', '创作资料在任务中发生变化；结果保留但不会覆盖当前作品', 409);
    if (r.owner !== owner) throw new DomainError('LEASE_LOST', '任务已由其他 Worker 接管', 409);
  }
  private async writeBook(initial: Run, owner: string, signal: AbortSignal) {
    while (this.store.getRun(initial.id).progress < initial.count) {
      this.checkpointPause(initial.id, owner, signal);
      const r = this.store.getRun(initial.id);
      const p = this.store.getProject(r.projectId);
      if (!p.approved || !p.volumes[String(r.volume)]?.approved)
        throw new DomainError('APPROVAL_REQUIRED', '请先确认全书蓝图和当前卷纲');
      const chapters = this.store.chapters(p.id);
      if (chapters.some((c) => c.status !== 'accepted'))
        throw new DomainError('CONTINUITY_PENDING', '存在草稿或待复核章节；请先收录，避免以过期记忆续写');
      if (chapters.reduce((n, c) => n + c.chars, 0) >= p.targetChars) {
        this.store.patchRun(r.id, owner, { status: 'completed', step: '已达到篇幅目标，请进行全书收束审校' });
        return;
      }
      const volume = p.volumes[String(r.volume)]!;
      const written = chapters.filter((c) => c.volume === r.volume).length;
      if (written >= volume.chapterCount) {
        await this.summarize(r, owner, signal);
        this.store.patchRun(r.id, owner, {
          status: 'paused',
          step: '本卷已完成，请复核并确认下一卷纲',
          error: null,
        });
        return;
      }
      let cp = r.checkpoint as ChapterCheckpoint;
      if (cp.committedChapter) cp = {};
      const number = (chapters.at(-1)?.number ?? 0) + 1;
      if (!cp.plan) {
        const plan = await this.call(
          r,
          owner,
          'plan',
          `从第${number}章开始；当前卷剩余${volume.chapterCount - written}章；每章目标${p.chapterTarget}字。${r.instruction}`,
          JSON.stringify({ volume, theme: p.outline?.theme, ending: p.outline?.ending }),
          scenePlanSchema,
          signal,
        );
        cp = { plan, title: plan.chapters[0]!.title, text: '', sceneIndex: 0 };
        this.store.patchRun(r.id, owner, { checkpoint: cp, step: `第${number}章场景计划已完成` });
      }
      const plan = cp.plan!.chapters[0]!;
      for (let i = cp.sceneIndex ?? 0; i < plan.scenes.length; i++) {
        this.checkpointPause(r.id, owner, signal);
        const scene = plan.scenes[i]!;
        const target = Math.ceil(p.chapterTarget / plan.scenes.length);
        const text = await this.callText(
          r,
          owner,
          'write',
          `写第${number}章第${i + 1}场景，目标约${target}字，仅完成本场景。${r.instruction}`,
          JSON.stringify({
            chapterGoal: plan.goal,
            scene,
            currentChapterText: cp.text,
            previousEnding: chapters.at(-1)?.text.slice(-1200) ?? '',
          }),
          signal,
          scene.cast,
          scene.pov,
        );
        cp = { ...cp, text: [cp.text, text].filter(Boolean).join('\n\n'), sceneIndex: i + 1 };
        this.store.patchRun(r.id, owner, {
          checkpoint: cp,
          step: `第${number}章 ${i + 1}/${plan.scenes.length}场景已保存`,
        });
      }
      this.checkpointPause(r.id, owner, signal);
      let text = cp.text!;
      let review = cp.review ?? (await this.review(r, owner, text, signal));
      cp = { ...cp, review };
      this.store.patchRun(r.id, owner, { checkpoint: cp, result: review });
      let round = cp.revisionRound ?? 0;
      while (review.findings.some((f) => f.severity !== 'minor') && round < this.config.revisionRounds) {
        const edits = await this.call(
          r,
          owner,
          'repair',
          `修复以下审校问题，保持授权设定：${JSON.stringify(review.findings)}`,
          text,
          repairSchema,
          signal,
          (value) => {
            applyTextEdits(text, value.edits);
          },
        );
        text = applyTextEdits(text, edits.edits);
        round++;
        cp = { ...cp, text, revisionRound: round, review: undefined };
        this.store.patchRun(r.id, owner, { checkpoint: cp });
        review = await this.review(r, owner, text, signal);
        cp.review = review;
        this.store.patchRun(r.id, owner, { checkpoint: cp, result: review });
      }
      if (review.findings.some((f) => f.severity !== 'minor'))
        throw new DomainError('QUALITY_GATE', '自动修订预算已用完；草稿与审校意见已保留，请处理重大问题');
      const extraction =
        cp.extraction ??
        (await this.call(
          r,
          owner,
          'extract',
          '提取本章事实、状态及摘要',
          text,
          extractionSchema,
          signal,
          (value) => {
            verifyFacts(text, value.facts);
          },
        ));
      verifyFacts(text, extraction.facts);
      cp.extraction = extraction;
      this.store.patchRun(r.id, owner, { checkpoint: cp });
      this.checkpointPause(r.id, owner, signal);
      const c = this.store.commitGenerated(
        r.id,
        owner,
        this.store.getRun(r.id).baseRevision,
        cp.title!,
        text,
        review,
        extraction.facts,
        extraction.summary,
      );
      await this.index(r, c.id).catch((e) => this.indexWarning(r, e));
      if (written + 1 >= volume.chapterCount) await this.summarize(this.store.getRun(r.id), owner, signal);
    }
    this.store.patchRun(initial.id, owner, { status: 'completed', step: '本次章节创作已完成' });
  }
  private async review(r: Run, owner: string, text: string, signal: AbortSignal): Promise<Review> {
    const review = await this.call(
      r,
      owner,
      'review',
      r.instruction,
      `【待审正文】\n${text}`,
      reviewSchema,
      signal,
      (value) => {
        for (const finding of value.findings)
          if (!finding.quote || !text.includes(finding.quote))
            throw new DomainError(
              'INVALID_REVIEW_EVIDENCE',
              'quote 必须逐字复制待审正文中的连续原文；不能来自其他资料或自行改写',
            );
      },
    );
    const majorIndexes = review.findings.flatMap((f, i) => (f.severity === 'minor' ? [] : [i]));
    if (!majorIndexes.length)
      return { ...review, findings: [...deterministicReview(text), ...review.findings] };
    const verification = await this.call(
      r,
      owner,
      'verify_review',
      '核实审校意见，禁止扩大审查范围',
      JSON.stringify({ manuscript: text, findings: review.findings }),
      reviewVerificationSchema,
      signal,
      (value) => {
        if (
          value.decisions.length !== majorIndexes.length ||
          new Set(value.decisions.map((d) => d.index)).size !== majorIndexes.length ||
          value.decisions.some((d) => !majorIndexes.includes(d.index))
        )
          throw new DomainError('INVALID_EVIDENCE', '须对每个非 minor 意见逐一核验，不得遗漏或额外添加');
      },
    );
    this.store.event(r.projectId, r.id, 'review.verified', {
      findings: review.findings,
      decisions: verification.decisions,
    });
    return {
      ...review,
      adjudication: verification.decisions,
      findings: [
        ...deterministicReview(text),
        ...review.findings.map((f, index) =>
          verification.decisions.some((d) => d.index === index && d.verdict === 'dismissed')
            ? {
                ...f,
                severity: 'minor' as const,
                explanation: `审校意见未获证据支持：${verification.decisions.find((d) => d.index === index)!.reason}`,
              }
            : f,
        ),
      ],
    };
  }
  private summarize(r: Run, owner: string, signal: AbortSignal) {
    return new DigestBuilder(this.store, this.config.summaryBatchSize, PROMPT_VERSION).build(
      r.id,
      owner,
      (input) =>
        this.call(r, owner, 'summarize', '压缩已发生事件并保留未完事项', input, digestContentSchema, signal),
      () => this.checkpointPause(r.id, owner, signal),
    );
  }
  private async materials(
    r: Run,
    p: Project,
    query: string,
    cast: string[] = [],
    prose = false,
    perspective?: string,
  ) {
    const before = r.chapterId
      ? this.store.getChapter(r.chapterId).number
      : (this.store.chapters(p.id).at(-1)?.number ?? 0) + 1;
    const entities = this.store
      .entities(p.id)
      .filter(
        (e) =>
          e.status === 'canon' &&
          e.narrativeFrom < before &&
          (e.narrativeTo === null || e.narrativeTo >= before - 1),
      );
    const pov = perspective ?? entities.find((e) => e.kind === 'character' && p.pov.includes(e.name))?.name;
    const relevant = entities.filter(
      (e) =>
        ['world', 'rule'].includes(e.kind) ||
        cast.includes(e.name) ||
        e.aliases.some((a) => query.includes(a)) ||
        query.includes(e.name),
    );
    const mandatory: Evidence[] = relevant.map((e) => ({
      id: e.id,
      source: 'entity',
      title: e.name,
      text: entityEvidence(e, prose),
      revision: e.revision,
      score: 1,
      mandatory: true,
    }));
    const digests = this.store
      .digests(p.id)
      .filter((d) => d.valid && d.sources.every((s) => s.number < before));
    const latestBook = digests
      .filter((d) => d.scope === 'book')
      .sort((a, b) => b.sources.length - a.sources.length || b.level - a.level)[0];
    if (latestBook)
      mandatory.push({
        id: latestBook.id,
        source: 'digest',
        title: '已发生全书摘要（需以原文为准）',
        text: JSON.stringify({
          summary: latestBook.summary,
          stateChanges: latestBook.stateChanges,
          openPromises: latestBook.openPromises,
          throughChapter: latestBook.sources.at(-1)?.number,
        }),
        revision: 1,
        score: 1,
        mandatory: true,
      });
    const memories = this.store
      .facts(p.id, before)
      .filter((m) => !prose || !['knowledge', 'belief'].includes(m.kind) || m.holder === pov);
    const state = new Map<string, (typeof memories)[number]>();
    const history: Evidence[] = [];
    for (const m of memories)
      if (
        relevant.some((e) => e.name === m.subject || e.name === m.holder) ||
        m.chapterNumber >= before - 2
      ) {
        if (['state', 'relationship'].includes(m.kind) || m.chapterNumber >= before - 2)
          state.set(
            ['state', 'relationship'].includes(m.kind)
              ? [m.subject, m.predicate, m.holder, m.kind].join('|')
              : m.id,
            m,
          );
        else
          history.push({
            id: m.id,
            source: 'memory',
            title: `${m.subject} · ${m.predicate}`,
            text: memoryEvidence(m),
            chapterId: m.chapterId,
            revision: m.chapterRevision,
            score: m.chapterNumber / before,
          });
      }
    for (const m of state.values())
      mandatory.push({
        id: m.id,
        source: 'memory',
        title: `${m.subject} · ${m.predicate}`,
        text: memoryEvidence(m),
        revision: m.chapterRevision,
        score: 1,
        mandatory: true,
      });
    const retrieved = await retrieve(
      this.store,
      this.embeddings,
      p.id,
      query,
      before,
      this.config.context.limit,
      this.config.context.rrfK,
    );
    if (retrieved.degraded)
      this.store.event(p.id, r.id, 'retrieval.degraded', { message: retrieved.degraded });
    const ids = new Set(mandatory.map((e) => e.id));
    return [
      ...mandatory,
      ...retrieved.evidence
        .filter((e) => !ids.has(e.id))
        .map((e) => {
          const entity = e.source === 'entity' ? entities.find((item) => item.id === e.id) : undefined;
          return entity ? { ...e, text: entityEvidence(entity, prose) } : e;
        }),
      ...history.sort((a, b) => b.score - a.score).slice(0, this.config.context.limit),
    ];
  }
  private async call<T>(
    r: Run,
    owner: string,
    task: keyof typeof taskPrompts,
    instruction: string,
    required: string,
    schema: z.ZodType<T>,
    signal: AbortSignal,
    validate?: (value: T) => void,
  ): Promise<T> {
    let correction = '';
    for (let attempt = 0; attempt <= this.config.retries; attempt++) {
      try {
        const text = await this.predict(
          r,
          owner,
          task,
          instruction + correction,
          required,
          signal,
          z.toJSONSchema(schema),
        );
        const value = schema.parse(JSON.parse(stripJsonFence(text)));
        validate?.(value);
        return value;
      } catch (e) {
        if (
          signal.aborted ||
          (e instanceof DomainError &&
            ![
              'MODEL_REQUEST_FAILED',
              'MODEL_STREAM_ERROR',
              'INCOMPLETE_STREAM',
              'OUTPUT_TRUNCATED',
              'INVALID_REVIEW_EVIDENCE',
              'INVALID_EVIDENCE',
            ].includes(e.code)) ||
          attempt === this.config.retries
        )
          throw e;
        correction = `\n上次结果未通过校验：${e instanceof Error ? e.message.slice(0, 400) : '格式错误'}。请重新生成完整 JSON，减少非必要条目，保持证据准确。`;
        this.store.event(r.projectId, r.id, 'task.retry', {
          task,
          attempt: attempt + 1,
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    }
    throw new DomainError('RETRY_EXHAUSTED', '重试次数已用完');
  }
  private callText(
    r: Run,
    owner: string,
    task: keyof typeof taskPrompts,
    instruction: string,
    required: string,
    signal: AbortSignal,
    cast?: string[],
    perspective?: string,
  ) {
    return this.predict(r, owner, task, instruction, required, signal, undefined, cast, perspective);
  }
  private async predict(
    r: Run,
    owner: string,
    task: keyof typeof taskPrompts,
    instruction: string,
    required: string,
    signal: AbortSignal,
    schema?: Record<string, unknown>,
    cast?: string[],
    perspective?: string,
  ) {
    this.checkpointPause(r.id, owner, signal);
    const p = this.store.getProject(r.projectId);
    this.store.patchRun(r.id, owner, { step: task });
    const timeout = AbortSignal.timeout(this.config.timeoutMs);
    const bounded = AbortSignal.any([signal, timeout]);
    const evidence = ['summarize', 'audit'].includes(task)
      ? []
      : await withSignal(
          this.materials(
            r,
            p,
            instruction + '\n' + required,
            cast,
            ['write', 'rewrite', 'polish'].includes(task),
            perspective,
          ),
          bounded,
        );
    const context = await withSignal(
      buildContext(this.model, p, task, instruction, evidence, required, this.config.context, schema),
      bounded,
    );
    this.store.saveTrace(r.id, context.manifest, context.messages);
    let draft = '';
    let lastWrite = 0;
    try {
      const result = await this.model.generate(context.messages, {
        signal: bounded,
        maxTokens: context.manifest.outputTokens,
        temperature: schema ? this.config.analysisTemperature : this.config.temperature,
        schema,
        onText: (chunk) => {
          draft += chunk;
          if (Date.now() - lastWrite > 1000) {
            this.store.event(p.id, r.id, 'generation.preview', { task, text: draft, provisional: true });
            lastWrite = Date.now();
          }
        },
      });
      this.store.saveTrace(r.id, context.manifest, [], result.stats);
      this.store.event(p.id, r.id, 'generation.finished', {
        task,
        chars: countChars(result.text),
        stopReason: result.stopReason,
        stats: result.stats,
      });
      if (!['stop', 'eosFound', 'stopStringFound'].includes(result.stopReason))
        throw new DomainError(
          'OUTPUT_TRUNCATED',
          `模型未完整结束：${result.stopReason}。已保存预览，请缩小任务或调整输出预算`,
        );
      if (!result.text.trim())
        throw new DomainError('EMPTY_OUTPUT', '模型未输出正文；检查思考控制和输出预算');
      return result.text;
    } catch (e) {
      this.store.event(p.id, r.id, 'generation.interrupted', {
        task,
        text: draft,
        provisional: true,
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  }
  private async index(r: Run, chapterId: string) {
    if (!this.embeddings) return;
    const chapter = this.store.getChapter(chapterId);
    const identity = await this.embeddings.identity();
    const paragraphs = chapter.text.split(/\n+/).filter(Boolean);
    const chunks: string[] = [];
    let chunk = '';
    for (const paragraph of paragraphs) {
      if (chunk && chunk.length + paragraph.length > this.config.embeddingChunkChars) {
        chunks.push(chunk);
        chunk = '';
      }
      for (let i = 0; i < paragraph.length; i += this.config.embeddingChunkChars) {
        const part = paragraph.slice(i, i + this.config.embeddingChunkChars);
        if (part.length === this.config.embeddingChunkChars) chunks.push(part);
        else chunk += (chunk ? '\n' : '') + part;
      }
    }
    if (chunk) chunks.push(chunk);
    for (const text of chunks)
      this.store.putVector(
        r.projectId,
        chapterId,
        chapter.revision,
        text,
        await this.embeddings.embed(text),
        identity,
      );
  }
  private indexWarning(r: Run, error: unknown) {
    this.store.event(r.projectId, r.id, 'index.pending', {
      message: error instanceof Error ? error.message : String(error),
      retry: '可在记忆页面重建索引；正式正文已安全保存',
    });
  }
}
