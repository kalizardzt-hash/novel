import { z } from 'zod';

export const entityKinds = [
  'character',
  'world',
  'location',
  'faction',
  'item',
  'rule',
  'relationship',
  'event',
  'foreshadowing',
] as const;
export const entityKindSchema = z.enum(entityKinds);
export type EntityKind = z.infer<typeof entityKindSchema>;
export const projectInputSchema = z.object({
  title: z.string().trim().min(1).max(160),
  premise: z.string().max(20000).default(''),
  genre: z.string().max(100).default('长篇类型小说'),
  tone: z.string().max(2000).default('克制、具体、人物驱动'),
  pov: z.string().max(300).default('第三人称限知，每场景一个视角'),
  audience: z.string().max(300).default('成人读者'),
  boundaries: z.string().max(2000).default(''),
  styleSample: z.string().max(12000).default(''),
  targetChars: z.number().int().min(1000).max(10000000).default(1000000),
  chapterTarget: z.number().int().min(200).max(10000).default(3000),
});
export type ProjectInput = z.infer<typeof projectInputSchema>;
export type Project = ProjectInput & {
  id: string;
  revision: number;
  outline: BookOutline | null;
  approved: boolean;
  volumes: Record<string, VolumePlan>;
  createdAt: string;
  updatedAt: string;
};
export const entityInputSchema = z.object({
  kind: entityKindSchema,
  name: z.string().trim().min(1).max(160),
  aliases: z.array(z.string().max(100)).max(100).default([]),
  description: z.string().max(20000).default(''),
  fields: z.record(z.string(), z.string().max(20000)).default({}),
  fieldVisibility: z.record(z.string(), z.enum(['public', 'author'])).default({}),
  fromEntityId: z.string().nullable().default(null),
  toEntityId: z.string().nullable().default(null),
  narrativeFrom: z.number().int().min(0).default(0),
  narrativeTo: z.number().int().min(0).nullable().default(null),
  storyTime: z.string().max(300).default(''),
  status: z.enum(['proposed', 'canon', 'retired']).default('canon'),
});
export type EntityInput = z.infer<typeof entityInputSchema>;
export type Entity = EntityInput & {
  id: string;
  projectId: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
};
export const blueprintSchema = z.object({
  premise: z.string(),
  theme: z.string(),
  ending: z.string(),
  volumes: z
    .array(
      z.object({
        number: z.number().int().positive(),
        title: z.string(),
        goal: z.string(),
        endState: z.string(),
        promises: z.array(z.string()),
      }),
    )
    .min(1)
    .max(30),
  characters: z
    .array(
      z.object({
        name: z.string(),
        role: z.string(),
        desire: z.string(),
        weakness: z.string(),
        voice: z.string(),
        arc: z.string(),
        secret: z.string(),
      }),
    )
    .max(30),
  worldRules: z
    .array(
      z.object({
        name: z.string(),
        condition: z.string(),
        effect: z.string(),
        limit: z.string(),
        cost: z.string(),
      }),
    )
    .max(30),
});
export type BookOutline = z.infer<typeof blueprintSchema>;
export const volumeSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  goal: z.string(),
  endState: z.string(),
  milestones: z.array(z.string()).min(1).max(20),
  characterArcs: z.array(z.string()),
  promises: z.array(z.string()),
  chapterCount: z.number().int().min(1).max(150),
});
export type VolumePlan = z.infer<typeof volumeSchema> & { approved: boolean };
export const scenePlanSchema = z.object({
  chapters: z
    .array(
      z.object({
        title: z.string(),
        goal: z.string(),
        scenes: z
          .array(
            z.object({
              title: z.string(),
              pov: z.string(),
              cast: z.array(z.string()),
              location: z.string(),
              storyTime: z.string(),
              desire: z.string(),
              opposition: z.string(),
              change: z.string(),
              reveal: z.string(),
              endState: z.string(),
            }),
          )
          .min(1)
          .max(6),
      }),
    )
    .min(1)
    .max(3),
});
export type ScenePlan = z.infer<typeof scenePlanSchema>;
export type Chapter = {
  id: string;
  projectId: string;
  number: number;
  volume: number;
  title: string;
  text: string;
  revision: number;
  status: 'draft' | 'accepted' | 'stale';
  chars: number;
  createdAt: string;
  updatedAt: string;
};
export type ChapterRevision = {
  id: string;
  chapterId: string;
  revision: number;
  title: string;
  text: string;
  reason: string;
  createdAt: string;
};
export const chapterInputSchema = z.object({
  title: z.string().min(1).max(300),
  text: z.string().max(200000),
  volume: z.number().int().positive().default(1),
});
export const factSchema = z.object({
  subject: z.string(),
  predicate: z.string(),
  value: z.string(),
  kind: z.enum(['fact', 'belief', 'knowledge', 'promise', 'relationship', 'state', 'summary']),
  holder: z.string().nullable(),
  storyTime: z.string(),
  quote: z.string().min(1),
});
export type ExtractedFact = z.infer<typeof factSchema>;
export type MemoryFact = ExtractedFact & {
  id: string;
  projectId: string;
  chapterId: string;
  chapterRevision: number;
  chapterNumber: number;
  valid: boolean;
  start: number;
  end: number;
  createdAt: string;
};
export type SourceRevision = { chapterId: string; revision: number; number: number };
export type ChapterDigest = SourceRevision & { volume: number; title: string; summary: string };
export const digestContentSchema = z.object({
  summary: z.string(),
  stateChanges: z.array(z.string()).max(12),
  openPromises: z.array(z.string()).max(12),
});
export type StoryDigest = z.infer<typeof digestContentSchema> & {
  id: string;
  projectId: string;
  key: string;
  scope: 'volume' | 'book';
  volume: number;
  level: number;
  sources: SourceRevision[];
  promptVersion: string;
  createdAt: string;
  valid: boolean;
};
export const auditSchema = z.object({
  conclusion: z.string(),
  findings: z
    .array(
      z.object({
        category: z.enum(['promise', 'character_arc', 'continuity', 'ending']),
        sourceChapterIds: z.array(z.string()).min(1),
        explanation: z.string(),
        nextCheck: z.string(),
      }),
    )
    .max(20),
});
export const extractionSchema = z.object({ summary: z.string(), facts: z.array(factSchema).max(80) });
export const repairSchema = z.object({
  edits: z
    .array(z.object({ quote: z.string().min(1), replacement: z.string() }))
    .min(1)
    .max(8),
});
export function applyTextEdits(text: string, edits: z.infer<typeof repairSchema>['edits']): string {
  const ranges = edits
    .map((edit) => {
      const start = text.indexOf(edit.quote);
      if (!edit.quote || start < 0 || text.indexOf(edit.quote, start + 1) >= 0)
        throw new DomainError('INVALID_EVIDENCE', '修订锚点必须在正文中唯一且逐字相同');
      return { ...edit, start, end: start + edit.quote.length };
    })
    .sort((a, b) => a.start - b.start);
  if (ranges.some((range, i) => i > 0 && range.start < ranges[i - 1]!.end))
    throw new DomainError('INVALID_EVIDENCE', '修订片段不能重叠');
  for (const range of ranges.reverse())
    text = text.slice(0, range.start) + range.replacement + text.slice(range.end);
  return text;
}
export const findingSchema = z.object({
  quote: z.string(),
  category: z.string(),
  explanation: z.string(),
  suggestion: z.string(),
  severity: z.enum(['blocker', 'major', 'minor']),
});
export type Finding = z.infer<typeof findingSchema>;
export const reviewSchema = z.object({
  findings: z.array(findingSchema).max(40),
  strengths: z.array(z.string()).max(8),
});
export const reviewVerificationSchema = z.object({
  decisions: z
    .array(
      z.object({
        index: z.number().int().min(0),
        reason: z.string(),
        verdict: z.enum(['upheld', 'dismissed', 'uncertain']),
      }),
    )
    .max(40),
});
export type Review = z.infer<typeof reviewSchema> & {
  adjudication?: z.infer<typeof reviewVerificationSchema>['decisions'];
};
export const taskKinds = [
  'blueprint',
  'volume',
  'write',
  'rewrite',
  'polish',
  'review',
  'extract',
  'ingest',
  'intent',
  'reindex',
  'summarize',
  'audit',
] as const;
export type TaskKind = (typeof taskKinds)[number];
export const runInputSchema = z.object({
  kind: z.enum(taskKinds),
  instruction: z.string().max(20000).default(''),
  chapterId: z.string().optional(),
  volume: z.number().int().min(1).max(30).default(1),
  count: z.number().int().min(1).max(1000).default(1),
});
export type RunInput = z.infer<typeof runInputSchema>;
export type RunStatus =
  'queued' | 'running' | 'awaiting_approval' | 'paused' | 'completed' | 'failed' | 'cancelled';
export type Run = RunInput & {
  id: string;
  projectId: string;
  status: RunStatus;
  step: string;
  progress: number;
  baseRevision: number;
  checkpoint: Record<string, unknown>;
  result: unknown;
  error: string | null;
  owner: string | null;
  leaseUntil: number | null;
  request: 'pause' | 'cancel' | null;
  createdAt: string;
  updatedAt: string;
};
export type RunEvent = {
  id: number;
  projectId: string;
  runId: string | null;
  type: string;
  data: unknown;
  createdAt: string;
};
export const intentSchema = z.object({
  intent: z.enum([
    'blueprint',
    'volume',
    'write',
    'rewrite',
    'polish',
    'review',
    'query',
    'edit_setting',
    'pause',
    'resume',
    'cancel',
    'clarify',
  ]),
  confidence: z.number().min(0).max(1),
  target: z.string().nullable(),
  instruction: z.string(),
  question: z.string().nullable(),
  answer: z.string().nullable(),
});
export type Evidence = {
  id: string;
  source: 'entity' | 'chapter' | 'memory' | 'digest';
  title: string;
  text: string;
  chapterId?: string;
  revision: number;
  score: number;
  mandatory?: boolean;
};
export type ContextManifest = {
  task: string;
  model: string;
  contextLimit: number;
  inputTokens: number;
  outputTokens: number;
  included: { id: string; title: string; reason: string; revision: number }[];
  omitted: string[];
  promptVersion: string;
};
export class DomainError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode = 400,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
export function countChars(text: string): number {
  return (text.match(/[\p{L}\p{N}]/gu) ?? []).length;
}
/** 剥离模型输出 JSON 时可能包裹的 Markdown 代码围栏与前后噪声。 */
export function stripJsonFence(text: string): string {
  let value = text.trim();
  const fenced = /^```(?:json|JSON)?\s*([\s\S]*?)\s*```$/.exec(value);
  if (fenced) value = fenced[1]!.trim();
  // 围栏之外的极端情况：仅保留首个 { 到最后一个 } 之间的内容。
  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  if (start > 0 && end > start) value = value.slice(start, end + 1);
  return value;
}
export function searchable(text: string): string {
  const normalized = text.normalize('NFKC').toLowerCase();
  const words = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  const grams = [...normalized].flatMap((char, i, all) =>
    /\p{Script=Han}/u.test(char)
      ? [char, ...(/\p{Script=Han}/u.test(all[i + 1] ?? '') ? [char + all[i + 1]] : [])]
      : [],
  );
  return [...new Set([...words, ...grams])].join(' ');
}
export function verifyFacts(
  text: string,
  facts: ExtractedFact[],
): (ExtractedFact & { start: number; end: number })[] {
  return facts.map((fact) => {
    const start = text.indexOf(fact.quote);
    if (start < 0 || !fact.quote.trim())
      throw new DomainError('INVALID_EVIDENCE', `记忆证据不在当前正文中：${fact.quote.slice(0, 80)}`);
    if (['belief', 'knowledge'].includes(fact.kind) && !fact.holder)
      throw new DomainError('MISSING_HOLDER', '信念和知识必须指定持有人');
    return { ...fact, start, end: start + fact.quote.length };
  });
}
export function deterministicReview(text: string): Finding[] {
  const findings: Finding[] = [];
  if (!text.trim())
    findings.push({
      severity: 'blocker',
      category: '完整性',
      quote: '',
      explanation: '正文为空',
      suggestion: '重新生成完整场景',
    });
  if (/<\/?think>|<\|im_start\|>/i.test(text))
    findings.push({
      severity: 'blocker',
      category: '输出污染',
      quote: text.match(/.{0,20}<\/?think>.{0,30}/)?.[0] ?? '',
      explanation: '正文含模型协议或思考标记',
      suggestion: '检查推理通道隔离',
    });
  const paragraphs = text
    .split(/\n+/)
    .map((p) => p.trim())
    .filter((p) => countChars(p) > 40);
  const seen = new Set<string>();
  for (const p of paragraphs) {
    if (seen.has(p))
      findings.push({
        severity: 'major',
        category: '重复',
        quote: p,
        explanation: '整段正文重复',
        suggestion: '删除重复并检查衔接',
      });
    seen.add(p);
  }
  return findings;
}
