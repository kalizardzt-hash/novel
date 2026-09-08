import type {
  BookOutline,
  Chapter,
  ChapterRevision,
  ContextManifest,
  Entity,
  EntityInput,
  Evidence,
  ExtractedFact,
  MemoryFact,
  Project,
  ProjectInput,
  Review,
  Run,
  RunEvent,
  RunInput,
  VolumePlan,
  ChapterDigest,
  StoryDigest,
} from '../../domain/src/index.ts';

export type Message = { role: 'system' | 'user' | 'assistant'; content: string };
/** 模型元信息。除 id 与 contextLength 外的字段由具体适配器尽力提供。 */
export type ModelInfo = {
  id: string;
  contextLength: number;
  path?: string;
  format?: string;
  structured?: boolean;
  reasoningControl?: 'tested-off' | 'untested';
};
export type GenerationOptions = {
  maxTokens: number;
  temperature: number;
  signal: AbortSignal;
  schema?: Record<string, unknown>;
  onText?: (text: string) => void;
};
export type GenerationResult = { text: string; stopReason: string; stats: Record<string, unknown> };
export interface LanguageModel {
  info(): Promise<ModelInfo>;
  countTokens(messages: Message[]): Promise<number>;
  generate(messages: Message[], options: GenerationOptions): Promise<GenerationResult>;
}
export interface Embeddings {
  identity(): Promise<string>;
  embed(text: string, query?: boolean): Promise<number[]>;
}
export interface StoryStore {
  listProjects(): Project[];
  getProject(id: string): Project;
  createProject(input: ProjectInput): Project;
  updateProject(id: string, input: ProjectInput, revision: number): Project;
  entities(projectId: string): Entity[];
  saveEntity(projectId: string, input: EntityInput, revision: number, id?: string): Entity;
  chapters(projectId: string): Chapter[];
  getChapter(id: string): Chapter;
  saveChapter(
    projectId: string,
    input: { title: string; text: string; volume: number },
    expectedRevision: number,
    id?: string,
    reason?: string,
  ): Chapter;
  revisions(chapterId: string): ChapterRevision[];
  importChapters(
    projectId: string,
    chapters: { title: string; text: string; volume: number }[],
    expectedRevision: number,
  ): Chapter[];
  facts(projectId: string, before?: number): MemoryFact[];
  chapterDigests(projectId: string): ChapterDigest[];
  digests(projectId: string): StoryDigest[];
  saveDigest(
    runId: string,
    owner: string,
    digest: Omit<StoryDigest, 'id' | 'projectId' | 'valid' | 'createdAt'>,
  ): StoryDigest;
  search(projectId: string, query: string, before?: number, limit?: number): Evidence[];
  impacts(projectId: string): { chapterId: string; title: string; reason: string; resolved: boolean }[];
  createRun(projectId: string, input: RunInput, key: string): Run;
  getRun(id: string): Run;
  runs(projectId: string): Run[];
  claim(owner: string, leaseMs: number): Run | null;
  heartbeat(id: string, owner: string, leaseMs: number): boolean;
  patchRun(id: string, owner: string, patch: Partial<Run>): Run;
  controlRun(id: string, action: 'pause' | 'resume' | 'cancel'): Run;
  approveRun(id: string, projectRevision: number): Run;
  reviseProposal(id: string, projectRevision: number, result: unknown): Run;
  events(projectId: string, after?: number): RunEvent[];
  latestEventId(projectId: string): number;
  event(projectId: string, runId: string | null, type: string, data: unknown): void;
  saveTrace(
    runId: string,
    manifest: ContextManifest,
    messages: Message[],
    stats?: Record<string, unknown>,
  ): string;
  traces(runId: string): unknown[];
  commitChapter(
    runId: string,
    owner: string,
    expectedRevision: number,
    chapterId: string,
    review: Review,
    facts: ExtractedFact[],
    summary: string,
  ): Chapter;
  completeBlueprint(runId: string, owner: string, outline: BookOutline): void;
  completeVolume(runId: string, owner: string, volume: VolumePlan): void;
  saveDraft(runId: string, owner: string, title: string, text: string, chapterId?: string): Chapter;
  commitGenerated(
    runId: string,
    owner: string,
    expectedRevision: number,
    title: string,
    text: string,
    review: Review,
    facts: ExtractedFact[],
    summary: string,
    chapterId?: string,
  ): Chapter;
  vectors(
    projectId: string,
    identity: string,
    before?: number,
  ): { id: string; chapterId: string; revision: number; text: string; vector: number[] }[];
  putVector(
    projectId: string,
    chapterId: string,
    revision: number,
    text: string,
    vector: number[],
    identity: string,
  ): void;
  backup(destination: string): Promise<void>;
  exportProject(id: string): unknown;
  importProject(data: unknown): Project;
  close(): void;
}
