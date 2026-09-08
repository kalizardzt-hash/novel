import {
  DomainError,
  type ChapterDigest,
  type StoryDigest,
  type SourceRevision,
  type digestContentSchema,
} from '../../domain/src/index.ts';
import type { z } from 'zod';
import type { StoryStore } from './ports.ts';

type Unit = { sources: SourceRevision[]; summary: string; stateChanges?: string[]; openPromises?: string[] };
export type DigestGenerator = (input: string) => Promise<z.infer<typeof digestContentSchema>>;
/** Bounded fan-in reduction. Every compressed node retains all original source revisions. */
export class DigestBuilder {
  constructor(
    private store: StoryStore,
    private batchSize: number,
    private promptVersion: string,
  ) {
    if (batchSize < 2) throw new DomainError('INVALID_CONFIG', '摘要分组至少包含两项');
  }
  async build(runId: string, owner: string, generate: DigestGenerator, checkpoint: () => void) {
    const run = this.store.getRun(runId);
    const chapters = this.store.chapterDigests(run.projectId);
    if (!chapters.length) throw new DomainError('NO_ACCEPTED_CHAPTERS', '请先收录正文再生成层级摘要');
    if (chapters.length !== this.store.chapters(run.projectId).length)
      throw new DomainError('CONTINUITY_PENDING', '请先按顺序复核所有章节');
    const cached = this.store.digests(run.projectId);
    const roots: StoryDigest[] = [];
    const nodes: StoryDigest[] = [];
    const reduce = async (units: Unit[], scope: StoryDigest['scope'], volume: number) => {
      let level = 0;
      let root: StoryDigest | undefined;
      do {
        const next: StoryDigest[] = [];
        for (let offset = 0; offset < units.length; offset += this.batchSize) {
          checkpoint();
          const group = units.slice(offset, offset + this.batchSize);
          const sources = group.flatMap((u) => u.sources);
          const key = [
            scope,
            volume,
            level,
            sources[0]!.chapterId,
            sources.at(-1)!.chapterId,
            this.promptVersion,
            sources.map((s) => s.revision).join(','),
          ].join(':');
          const hit = cached.find(
            (d) =>
              d.key === key &&
              d.valid &&
              d.promptVersion === this.promptVersion &&
              JSON.stringify(d.sources) === JSON.stringify(sources),
          );
          if (hit) next.push(hit);
          else {
            // Only small source ranges are sent at upper levels; complete lineage is stored outside the prompt.
            const input = JSON.stringify({
              scope,
              volume,
              level,
              sections: group.map((u) => ({
                from: u.sources[0]!.number,
                through: u.sources.at(-1)!.number,
                summary: u.summary,
                stateChanges: u.stateChanges,
                openPromises: u.openPromises,
              })),
            });
            const content = await generate(input);
            checkpoint();
            next.push(
              this.store.saveDigest(runId, owner, {
                ...content,
                key,
                scope,
                volume,
                level,
                sources,
                promptVersion: this.promptVersion,
              }),
            );
          }
        }
        root = next[0];
        nodes.push(...next);
        units = next;
        level++;
      } while (units.length > 1);
      return root!;
    };
    for (const volume of [...new Set(chapters.map((c) => c.volume))]) {
      const units = chapters
        .filter((c) => c.volume === volume)
        .map((c: ChapterDigest) => ({
          sources: [{ chapterId: c.chapterId, revision: c.revision, number: c.number }],
          summary: c.summary,
        }));
      roots.push(await reduce(units, 'volume', volume));
    }
    const book = await reduce(roots, 'book', 0);
    return { book, volumes: roots, nodes };
  }
}
