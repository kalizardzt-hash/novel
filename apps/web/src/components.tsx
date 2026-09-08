import { useEffect, useRef, useState, useId, cloneElement, isValidElement, type ReactNode } from 'react';
import { z } from 'zod';
import { SchemaForm, type FormSchema } from './schema-form.tsx';
import { useQuery } from '@tanstack/react-query';
import {
  Plus,
  X,
  Save,
  ArrowUpRight,
  BookOpen,
  History,
  Check,
  Upload,
  Download,
  Search,
  RefreshCw,
  Sparkles,
  Settings2,
} from 'lucide-react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { ReactFlow, Background, Controls, useNodesState } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { cardTemplates, fieldVisibility } from '../../../packages/domain/src/templates.ts';
import {
  entityInputSchema,
  blueprintSchema,
  volumeSchema,
  projectInputSchema,
  countChars,
  type Chapter,
  type ChapterRevision,
  type Entity,
  type EntityKind,
  type MemoryFact,
  type Project,
  type Run,
  type RunInput,
  type StoryDigest,
} from '../../../packages/domain/src/index.ts';
import type { AppConfig } from '../../../packages/application/src/settings.ts';
import { api, send, statusLabels, taskLabels, type Workspace } from './api.ts';
export type Action = (work: () => Promise<unknown>, success?: string) => Promise<void>;
export const Field = ({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) => {
  const id = useId();
  return (
    <label className="field">
      <span id={id}>{label}</span>
      {isValidElement<{ 'aria-labelledby'?: string; 'aria-describedby'?: string }>(children)
        ? cloneElement(children, {
            'aria-labelledby': id,
            'aria-describedby': hint ? `${id}-hint` : undefined,
          })
        : children}
      {hint && <small id={`${id}-hint`}>{hint}</small>}
    </label>
  );
};
export const Empty = ({ title, children }: { title: string; children?: ReactNode }) => (
  <div className="empty">
    <BookOpen size={30} />
    <h3>{title}</h3>
    <div>{children}</div>
  </div>
);
export function Modal({ title, children, close }: { title: string; children: ReactNode; close: () => void }) {
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <section className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <header>
          <h2>{title}</h2>
          <button className="icon-button" aria-label="关闭" onClick={close}>
            <X size={20} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
export function ProjectForm({
  existing,
  close,
  action,
  created,
}: {
  existing?: Project;
  close: () => void;
  action: Action;
  created: (id: string) => void;
}) {
  const [form, set] = useState(
    existing
      ? projectInputSchema.parse(existing)
      : { ...projectInputSchema.parse({ title: '新作品' }), title: '' },
  );
  return (
    <Modal title={existing ? '创作约定' : '从一个念头开始'} close={close}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void action(
            async () => {
              const p = await send<Project>(
                existing ? `/projects/${existing.id}` : '/projects',
                { ...form, ...(existing ? { revision: existing.revision } : {}) },
                existing ? 'PUT' : 'POST',
              );
              created(p.id);
              close();
            },
            existing ? '创作约定已保存' : '作品已创建',
          );
        }}
      >
        <Field label="作品名称">
          <input
            required
            autoFocus
            value={form.title}
            onChange={(e) => set({ ...form, title: e.target.value })}
            placeholder="给这个世界一个名字"
          />
        </Field>
        <Field label="故事的种子">
          <textarea
            rows={4}
            value={form.premise}
            onChange={(e) => set({ ...form, premise: e.target.value })}
            placeholder="谁，想要什么，遭遇了什么阻力，又将付出怎样的代价？"
          />
        </Field>
        <div className="form-grid">
          <Field label="题材">
            <input value={form.genre} onChange={(e) => set({ ...form, genre: e.target.value })} />
          </Field>
          <Field label="目标字数">
            <input
              type="number"
              min={1000}
              max={10000000}
              value={form.targetChars}
              onChange={(e) => set({ ...form, targetChars: Number(e.target.value) })}
            />
          </Field>
          <Field label="叙事视角">
            <input value={form.pov} onChange={(e) => set({ ...form, pov: e.target.value })} />
          </Field>
          <Field label="每章目标字数">
            <input
              type="number"
              min={200}
              max={10000}
              value={form.chapterTarget}
              onChange={(e) => set({ ...form, chapterTarget: Number(e.target.value) })}
            />
          </Field>
        </div>
        <Field label="语言与基调">
          <input value={form.tone} onChange={(e) => set({ ...form, tone: e.target.value })} />
        </Field>
        <details>
          <summary>读者、内容边界与文风样本</summary>
          <Field label="目标读者">
            <input value={form.audience} onChange={(e) => set({ ...form, audience: e.target.value })} />
          </Field>
          <Field label="内容边界">
            <textarea
              value={form.boundaries}
              onChange={(e) => set({ ...form, boundaries: e.target.value })}
            />
          </Field>
          <Field label="文风参考片段">
            <textarea
              rows={5}
              value={form.styleSample}
              onChange={(e) => set({ ...form, styleSample: e.target.value })}
            />
          </Field>
        </details>
        <footer>
          <button type="button" className="secondary" onClick={close}>
            取消
          </button>
          <button className="primary" type="submit">
            {existing ? '保存约定' : '创建作品'}
            <ArrowUpRight size={16} />
          </button>
        </footer>
      </form>
    </Modal>
  );
}
export function EntityPanel({
  workspace: w,
  kinds,
  action,
}: {
  workspace: Workspace;
  kinds: EntityKind[];
  action: Action;
}) {
  const [selected, setSelected] = useState<Entity | null | undefined>();
  const [query, setQuery] = useState('');
  const items = w.entities.filter(
    (e) => kinds.includes(e.kind) && `${e.name}${e.description}${e.aliases.join('')}`.includes(query),
  );
  return (
    <>
      <div className="section-tools">
        <div className="search-box">
          <Search size={16} />
          <input
            placeholder="搜索名称、别名或描述"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <button className="primary" onClick={() => setSelected(null)}>
          <Plus size={16} />
          新建设定
        </button>
      </div>
      <div className="card-grid">
        {items.map((entity, i) => (
          <button className="entity-card" key={entity.id} onClick={() => setSelected(entity)}>
            <div className="card-top">
              <span className={`avatar avatar-${i % 4}`}>{entity.name.slice(0, 1)}</span>
              <span className="eyebrow">
                {cardTemplates[entity.kind].label} · {statusLabels[entity.status]}
              </span>
            </div>
            <h3>{entity.name}</h3>
            <p>{entity.description || Object.values(entity.fields).find(Boolean) || '等待你赋予细节'}</p>
            <div className="card-bottom">
              <span>{Object.values(entity.fields).filter(Boolean).length} 项设定</span>
              <ArrowUpRight size={15} />
            </div>
          </button>
        ))}
      </div>
      {!items.length && (
        <Empty title="让故事中的世界逐渐清晰">
          可以手动建立设定，也可以确认全书蓝图后自动生成人物与规则。
        </Empty>
      )}
      {selected !== undefined && (
        <EntityEditor
          existing={selected}
          kinds={kinds}
          workspace={w}
          action={action}
          close={() => setSelected(undefined)}
        />
      )}
    </>
  );
}
function EntityEditor({
  existing,
  kinds,
  workspace: w,
  action,
  close,
}: {
  existing: Entity | null;
  kinds: EntityKind[];
  workspace: Workspace;
  action: Action;
  close: () => void;
}) {
  const [form, set] = useState(entityInputSchema.parse(existing ?? { kind: kinds[0], name: '新设定' }));
  const [key, setKey] = useState('');
  const fields = [...new Set([...cardTemplates[form.kind].fields, ...Object.keys(form.fields)])];
  return (
    <Modal title={existing ? `编辑 · ${existing.name}` : '新建设定卡'} close={close}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void action(async () => {
            await send(
              `/projects/${w.project.id}/entities${existing ? '/' + existing.id : ''}`,
              { ...form, revision: w.project.revision },
              existing ? 'PUT' : 'POST',
            );
            close();
          }, '设定已保存，相关正文已标记复核');
        }}
      >
        <div className="form-grid">
          <Field label="设定类型">
            <select value={form.kind} onChange={(e) => set({ ...form, kind: e.target.value as EntityKind })}>
              {kinds.map((k) => (
                <option value={k} key={k}>
                  {cardTemplates[k].label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="名称">
            <input required value={form.name} onChange={(e) => set({ ...form, name: e.target.value })} />
          </Field>
        </div>
        <Field label="一句话描述">
          <textarea
            rows={2}
            value={form.description}
            onChange={(e) => set({ ...form, description: e.target.value })}
          />
        </Field>
        <Field label="别名 / 称谓" hint="用逗号分隔">
          <input
            value={form.aliases.join('，')}
            onChange={(e) =>
              set({
                ...form,
                aliases: e.target.value
                  .split(/[,，]/)
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
          />
        </Field>
        {fields.map((field) => (
          <div key={field}>
            <Field label={field}>
              <textarea
                rows={2}
                value={form.fields[field] ?? ''}
                onChange={(e) => set({ ...form, fields: { ...form.fields, [field]: e.target.value } })}
              />
            </Field>
            <label className="visibility-choice">
              <input
                type="checkbox"
                checked={fieldVisibility(form, field) === 'author'}
                onChange={(e) =>
                  set({
                    ...form,
                    fieldVisibility: {
                      ...form.fieldVisibility,
                      [field]: e.target.checked ? 'author' : 'public',
                    },
                  })
                }
              />
              仅用于规划与审校，写正文时隐藏
            </label>
          </div>
        ))}
        <div className="inline">
          <input
            aria-label="自定义字段名"
            placeholder="添加自定义字段"
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
          <button
            type="button"
            className="secondary"
            onClick={() => {
              if (key.trim()) set({ ...form, fields: { ...form.fields, [key.trim()]: '' } });
              setKey('');
            }}
          >
            <Plus size={16} />
          </button>
        </div>
        {form.kind === 'relationship' && (
          <div className="form-grid">
            {(['fromEntityId', 'toEntityId'] as const).map((field, i) => (
              <Field key={field} label={i ? '关系终点' : '关系起点'}>
                <select
                  value={form[field] ?? ''}
                  onChange={(e) => set({ ...form, [field]: e.target.value || null })}
                >
                  <option value="">选择人物 / 势力</option>
                  {w.entities
                    .filter((e) => e.kind !== 'relationship')
                    .map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.name}
                      </option>
                    ))}
                </select>
              </Field>
            ))}
          </div>
        )}
        <details>
          <summary>状态、时间与生效范围</summary>
          <div className="form-grid">
            <Field label="设定状态">
              <select
                value={form.status}
                onChange={(e) => set({ ...form, status: e.target.value as typeof form.status })}
              >
                {['canon', 'proposed', 'retired'].map((s) => (
                  <option key={s} value={s}>
                    {statusLabels[s]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="故事时间">
              <input value={form.storyTime} onChange={(e) => set({ ...form, storyTime: e.target.value })} />
            </Field>
            <Field label="从第几章生效（0 = 开篇前）">
              <input
                type="number"
                min={0}
                value={form.narrativeFrom}
                onChange={(e) => set({ ...form, narrativeFrom: Number(e.target.value) })}
              />
            </Field>
            <Field label="生效结束章节（留空 = 持续）">
              <input
                type="number"
                min={0}
                value={form.narrativeTo ?? ''}
                onChange={(e) =>
                  set({ ...form, narrativeTo: e.target.value ? Number(e.target.value) : null })
                }
              />
            </Field>
          </div>
        </details>
        <footer>
          <button type="button" className="secondary" onClick={close}>
            取消
          </button>
          <button className="primary">
            <Save size={16} />
            保存设定
          </button>
        </footer>
      </form>
    </Modal>
  );
}
const documentOf = (text: string) => ({
  type: 'doc',
  content: text
    .split(/\n\n+/)
    .map((p) => ({ type: 'paragraph', ...(p ? { content: [{ type: 'text', text: p }] } : {}) })),
});
export function Manuscript({
  workspace: w,
  selected,
  select,
  action,
  run,
}: {
  workspace: Workspace;
  selected: string;
  select: (id: string) => void;
  action: Action;
  run: (input: Partial<RunInput> & { kind: RunInput['kind'] }) => void;
}) {
  const query = useQuery({
    queryKey: ['chapter', selected],
    queryFn: () => api<Chapter>(`/chapters/${selected}`),
    enabled: Boolean(selected),
  });
  const chapter = query.data;
  const [text, setText] = useState('');
  const [title, setTitle] = useState('');
  const [dirty, setDirty] = useState(false);
  const [history, setHistory] = useState(false);
  // 编辑器回调在选中章节变化时重建；用 ref 读取最新版本号，避免闭包里的过期 revision
  // 让浏览器暂存被误判为陈旧而丢失。
  const chapterRef = useRef(chapter);
  chapterRef.current = chapter;
  const editor = useEditor(
    {
      extensions: [StarterKit],
      content: '',
      editorProps: { attributes: { 'aria-label': '小说正文', class: 'manuscript-prose' } },
      onUpdate: ({ editor }) => {
        const next = editor.getText({ blockSeparator: '\n\n' });
        setText(next);
        setDirty(true);
        if (selected)
          localStorage.setItem(
            'novel-draft-' + selected,
            JSON.stringify({ text: next, revision: chapterRef.current?.revision }),
          );
      },
    },
    [selected],
  );
  useEffect(() => {
    if (!chapter || !editor) return;
    let content = chapter.text;
    let recovered = false;
    try {
      const saved = JSON.parse(localStorage.getItem('novel-draft-' + chapter.id) ?? 'null');
      if (saved?.revision === chapter.revision && saved.text !== chapter.text) {
        content = saved.text;
        recovered = true;
      }
    } catch {}
    setText(content);
    setTitle(chapter.title);
    editor.commands.setContent(documentOf(content), { emitUpdate: false });
    setDirty(recovered);
  }, [chapter?.id, chapter?.revision, editor]);
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);
  const revisions = useQuery({
    queryKey: ['revisions', selected],
    queryFn: () => api<ChapterRevision[]>(`/chapters/${selected}/revisions`),
    enabled: Boolean(selected) && history,
  });
  return (
    <>
      <div className="section-tools">
        <select aria-label="选择章节" value={selected} onChange={(e) => select(e.target.value)}>
          <option value="">选择章节</option>
          {w.chapters.map((c) => (
            <option value={c.id} key={c.id}>
              第{c.number}章 · {c.title} · {statusLabels[c.status]}
            </option>
          ))}
        </select>
        {w.chapters.some((c) => c.status !== 'accepted') && (
          <button
            className="secondary"
            disabled={dirty}
            onClick={() =>
              run({ kind: 'ingest', count: w.chapters.filter((c) => c.status !== 'accepted').length })
            }
          >
            顺序审校收录
          </button>
        )}
        <div className="inline">
          <button
            className="secondary"
            onClick={() =>
              void action(async () => {
                const c = await send<Chapter>(`/projects/${w.project.id}/chapters`, {
                  title: `新章节`,
                  text: '',
                  volume: 1,
                  revision: w.project.revision,
                });
                select(c.id);
              })
            }
          >
            <Plus size={16} />
            手写一章
          </button>
          <label className="button secondary">
            <Upload size={16} />
            导入
            <input
              type="file"
              accept=".txt,.md,.markdown"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f)
                  void action(async () => {
                    const data = new FormData();
                    data.append('file', f);
                    await api(`/projects/${w.project.id}/import`, { method: 'POST', body: data });
                  }, '原文已导入，待审校收录');
              }}
            />
          </label>
        </div>
      </div>
      {!chapter ? (
        <Empty title="故事从第一行开始">选择已有章节、导入原稿，或在右侧开始创作。</Empty>
      ) : (
        <>
          <div className="editor-toolbar">
            <span className={`badge ${chapter.status}`}>{statusLabels[chapter.status]}</span>
            <span>{dirty ? '本机草稿已暂存' : `已保存 · 第 ${chapter.revision} 版`}</span>
            <span className="spacer" />
            <button className="text-button" onClick={() => setHistory(true)}>
              <History size={15} />
              历史版本
            </button>
            <button
              className="primary compact"
              onClick={() =>
                void action(async () => {
                  await send(
                    `/chapters/${chapter.id}`,
                    { title, text, volume: chapter.volume, revision: w.project.revision },
                    'PUT',
                  );
                  localStorage.removeItem('novel-draft-' + chapter.id);
                  setDirty(false);
                }, '正文已保存为草稿')
              }
            >
              <Save size={15} />
              保存
            </button>
          </div>
          <article className="paper">
            <span className="eyebrow">CHAPTER {String(chapter.number).padStart(2, '0')}</span>
            <input
              className="chapter-title"
              aria-label="章节标题"
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                setDirty(true);
              }}
            />
            <EditorContent editor={editor} />
            <div className="paper-footer">
              <span>{countChars(text).toLocaleString()} 字</span>
              <span>创作有迹可循</span>
            </div>
          </article>
          <div className="section-tools end">
            <button
              className="secondary"
              disabled={dirty}
              onClick={() => run({ kind: 'review', chapterId: selected })}
            >
              审校本章
            </button>
            <button
              className="primary"
              disabled={dirty || !text.trim()}
              onClick={() => run({ kind: 'extract', chapterId: selected })}
            >
              <Check size={16} />
              审校并收录记忆
            </button>
          </div>
        </>
      )}
      {history && (
        <Modal title="章节历史 · 恢复会创建新版本" close={() => setHistory(false)}>
          {revisions.data?.map((r) => (
            <details key={r.id}>
              <summary>
                第 {r.revision} 版 · {r.reason} · {new Date(r.createdAt).toLocaleString()}
              </summary>
              <pre className="prose-preview">{r.text}</pre>
              <button
                className="secondary"
                onClick={() =>
                  void action(async () => {
                    await send(`/chapters/${selected}/restore`, {
                      revision: w.project.revision,
                      sourceRevision: r.revision,
                    });
                    setHistory(false);
                  }, '已创建恢复版本，相关记忆待复核')
                }
              >
                恢复这一版
              </button>
            </details>
          ))}
        </Modal>
      )}
    </>
  );
}
export function Outline({
  workspace: w,
  run,
  action,
}: {
  workspace: Workspace;
  run: (input: Partial<RunInput> & { kind: RunInput['kind'] }) => void;
  action: Action;
}) {
  const pending = w.runs.filter((r) => r.status === 'awaiting_approval');
  const [editing, setEditing] = useState<Run | null>(null);
  return (
    <>
      <div className="section-tools">
        <p>先确定故事要去哪里，再把眼前的路写清楚。</p>
        <button className="primary" onClick={() => run({ kind: 'blueprint' })}>
          <Sparkles size={16} />
          规划全书蓝图
        </button>
      </div>
      {pending.map((r) => (
        <div className="approval-card" key={r.id}>
          <span className="eyebrow">等待你的确认</span>
          <h3>{taskLabels[r.kind]}</h3>
          <StructuredResult value={r.result} />
          <button className="secondary" onClick={() => setEditing(r)}>
            调整方案
          </button>
          <button
            className="primary"
            onClick={() =>
              void action(
                () => send(`/runs/${r.id}/approve`, { revision: w.project.revision }),
                '规划已确认，可推进下一阶段',
              )
            }
          >
            <Check size={16} />
            确认并采用
          </button>
        </div>
      ))}
      {editing && (
        <ProposalEditor
          run={editing}
          revision={w.project.revision}
          action={action}
          close={() => setEditing(null)}
        />
      )}
      {w.project.outline ? (
        <>
          <div className="quote-card">
            <span className="eyebrow">主题 · THEME</span>
            <h2>{w.project.outline.theme}</h2>
            <p>{w.project.outline.premise}</p>
            <details>
              <summary>结局方向（作者视角）</summary>
              <p>{w.project.outline.ending}</p>
            </details>
          </div>
          <div className="volume-list">
            {w.project.outline.volumes.map((v) => (
              <section className="volume-card" key={v.number}>
                <span className="volume-number">{String(v.number).padStart(2, '0')}</span>
                <div>
                  <span className="eyebrow">第 {v.number} 卷</span>
                  <h3>{v.title}</h3>
                  <p>{v.goal}</p>
                  <p className="muted">出口状态：{v.endState}</p>
                  {v.promises.length > 0 && <p>伏笔责任：{v.promises.join('；')}</p>}
                  {w.project.volumes[String(v.number)] && (
                    <details>
                      <summary>已确认卷纲 · {w.project.volumes[String(v.number)]!.chapterCount} 章</summary>
                      <StructuredResult value={w.project.volumes[String(v.number)]} />
                    </details>
                  )}
                  <button className="secondary" onClick={() => run({ kind: 'volume', volume: v.number })}>
                    规划第 {v.number} 卷<ArrowUpRight size={15} />
                  </button>
                </div>
              </section>
            ))}
          </div>
        </>
      ) : (
        !pending.length && <Empty title="全书蓝图尚未展开">创作约定、世界规则和人物卡会共同参与规划。</Empty>
      )}
    </>
  );
}
const resultLabels: Record<string, string> = {
  premise: '故事核心',
  theme: '主题',
  ending: '结局方向',
  volumes: '分卷',
  characters: '人物',
  worldRules: '世界规则',
  title: '标题',
  goal: '目标',
  endState: '出口状态',
  promises: '伏笔责任',
  name: '名称',
  desire: '欲望',
  weakness: '弱点',
  voice: '说话方式',
  arc: '人物弧',
  secret: '秘密',
  role: '角色',
  condition: '条件',
  effect: '效果',
  limit: '限制',
  cost: '代价',
  number: '序号',
  milestones: '里程碑',
  characterArcs: '人物弧',
  chapterCount: '章节数',
  findings: '审校发现',
  strengths: '优点',
  severity: '程度',
  category: '类别',
  quote: '原文证据',
  explanation: '问题说明',
  suggestion: '修正建议',
  summary: '摘要',
  text: '修订正文',
  review: '审校',
  intent: '意图',
  confidence: '置信度',
  question: '待澄清',
  answer: '回答',
  target: '目标',
  instruction: '行动建议',
  adjudication: '审校意见复核',
  index: '原意见下标',
  verdict: '复核判断',
  reason: '依据',
  conclusion: '结论',
  coveredChapters: '覆盖章节',
  scope: '检查范围',
  sections: '分组检查',
  sourceChapterIds: '来源章节',
  nextCheck: '原文核查建议',
  stateChanges: '状态变化',
  openPromises: '未完承诺',
};
export function StructuredResult({ value }: { value: unknown }) {
  if (value == null) return null;
  if (typeof value !== 'object') return <span className="result-value">{String(value)}</span>;
  if (Array.isArray(value))
    return (
      <div className="result-list">
        {value.map((v, i) => (
          <div key={i}>
            <StructuredResult value={v} />
          </div>
        ))}
      </div>
    );
  return (
    <dl className="result-fields">
      {Object.entries(value)
        .filter(([key]) => !['approved'].includes(key))
        .map(([key, v]) => (
          <div key={key}>
            <dt>{resultLabels[key] ?? key}</dt>
            <dd>
              <StructuredResult value={v} />
            </dd>
          </div>
        ))}
    </dl>
  );
}
export function RelationshipGraph({ entities }: { entities: Entity[] }) {
  const people = entities.filter((e) => ['character', 'faction'].includes(e.kind));
  const [nodes, setNodes, onNodesChange] = useNodesState(
    people.map((e, i) => ({
      id: e.id,
      position: { x: (i % 3) * 240 + 40, y: Math.floor(i / 3) * 180 + 40 },
      data: { label: e.name },
      style: {
        background: '#f9f8f3',
        border: '1px solid #779488',
        borderRadius: 12,
        padding: 20,
        color: '#294f46',
      },
    })),
  );
  const signature = JSON.stringify(people.map((e) => ({ id: e.id, name: e.name })));
  useEffect(() => {
    setNodes((previous) =>
      people.map((e, i) => ({
        id: e.id,
        data: { label: e.name },
        position: previous.find((n) => n.id === e.id)?.position ?? {
          x: (i % 3) * 240 + 40,
          y: Math.floor(i / 3) * 180 + 40,
        },
        style: {
          background: '#f9f8f3',
          border: '1px solid #779488',
          borderRadius: 12,
          padding: 20,
          color: '#294f46',
        },
      })),
    );
  }, [signature, setNodes]);
  const ids = new Set(people.map((e) => e.id));
  const edges = entities
    .filter(
      (e) =>
        e.kind === 'relationship' &&
        e.fromEntityId &&
        e.toEntityId &&
        ids.has(e.fromEntityId) &&
        ids.has(e.toEntityId),
    )
    .map((e) => ({
      id: e.id,
      source: e.fromEntityId!,
      target: e.toEntityId!,
      label: e.name,
      type: 'smoothstep',
    }));
  return (
    <>
      <p className="section-description">
        关系由设定卡关联生成。拖动整理视图，在人物页面建立关系卡可添加连线。
      </p>
      {nodes.length ? (
        <div className="graph">
          <ReactFlow nodes={nodes} onNodesChange={onNodesChange} edges={edges} fitView>
            <Background color="#c5cec6" gap={24} />
            <Controls />
          </ReactFlow>
        </div>
      ) : (
        <Empty title="先让人物相遇">建立人物、势力与关系卡后，这里会展示他们的关联。</Empty>
      )}
    </>
  );
}
export function MemoryPanel({
  workspace: w,
  run,
}: {
  workspace: Workspace;
  run: (input: Partial<RunInput> & { kind: RunInput['kind'] }) => void;
}) {
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const data = useQuery({
    queryKey: ['memory', w.project.id, search, offset, w.project.revision],
    queryFn: () =>
      api<{
        facts: MemoryFact[];
        total: number;
        hits: { id: string; title: string; text: string }[];
        digests: StoryDigest[];
      }>(`/projects/${w.project.id}/memory?query=${encodeURIComponent(search)}&offset=${offset}`),
  });
  return (
    <>
      <div className="section-tools">
        <form
          className="search-box"
          onSubmit={(e) => {
            e.preventDefault();
            setSearch(query);
          }}
        >
          <Search size={16} />
          <input
            placeholder="检索人物、物品、过往事件…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </form>
        <button className="secondary" onClick={() => run({ kind: 'reindex' })}>
          <RefreshCw size={15} />
          重建语义索引
        </button>
        <button className="secondary" onClick={() => run({ kind: 'summarize' })}>
          更新卷与全书摘要
        </button>
        <button className="secondary" onClick={() => run({ kind: 'audit' })}>
          收束审计
        </button>
      </div>
      {!!data.data?.digests.length && (
        <section className="card">
          <h3>层级记忆</h3>
          <p className="muted">由正式稿逐层压缩；摘要用于导航，事实以原文为准。</p>
          {data.data.digests
            .slice()
            .reverse()
            .map((d) => (
              <details key={d.id}>
                <summary>
                  {d.scope === 'book' ? '全书' : `第${d.volume}卷`} · 第{d.sources[0]?.number}—
                  {d.sources.at(-1)?.number}章 · {d.valid ? '来源有效' : '来源已变更，待重建'}
                </summary>
                <p>{d.summary}</p>
                <p>未完事项：{d.openPromises.join('；') || '未记录'}</p>
                <small>
                  覆盖 {d.sources.length} 个原文版本 · {d.promptVersion}
                </small>
              </details>
            ))}
        </section>
      )}
      {w.impacts.length > 0 && (
        <div className="notice">
          <strong>{new Set(w.impacts.map((i) => i.chapterId)).size} 个章节需要复核</strong>
          <p>前文或设定已更新，旧记忆已停用。</p>
          <details>
            <summary>查看影响范围</summary>
            {w.impacts.map((i, n) => (
              <p key={n}>
                {i.title} · {i.reason}
              </p>
            ))}
          </details>
        </div>
      )}
      {search && (
        <section>
          <h3>检索证据</h3>
          {data.data?.hits.map((hit) => (
            <details key={hit.id}>
              <summary>{hit.title}</summary>
              <pre className="prose-preview">{hit.text}</pre>
            </details>
          ))}
        </section>
      )}
      <h3 className="section-label">
        可追溯记忆 <span>{data.data?.total ?? 0}</span>
      </h3>
      {data.data?.facts.map((f) => (
        <div className="memory-card" key={f.id}>
          <div>
            <strong>{f.subject}</strong>
            <span className="badge">
              {f.kind}
              {f.holder ? ` · ${f.holder}所知` : ''}
            </span>
          </div>
          <p>
            {f.predicate}：{f.value}
          </p>
          <blockquote>{f.quote}</blockquote>
          <small>
            第 {f.chapterNumber} 章 · 正文版本 {f.chapterRevision} · {f.storyTime || '故事时间未明确'}
          </small>
        </div>
      ))}
      {!data.data?.total && (
        <Empty title="记忆会随着故事生长">
          章节通过审校并正式收录后，事实、人物知识和状态会出现在这里，每一项都有原文证据。
        </Empty>
      )}
      <div className="inline">
        <button className="secondary" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 100))}>
          上一页
        </button>
        <button
          className="secondary"
          disabled={offset + 100 >= (data.data?.total ?? 0)}
          onClick={() => setOffset(offset + 100)}
        >
          下一页
        </button>
      </div>
    </>
  );
}
export function RunsPanel({ workspace: w, action }: { workspace: Workspace; action: Action }) {
  const [trace, setTrace] = useState<string | null>(null);
  const traces = useQuery({
    queryKey: ['traces', trace],
    queryFn: () => api<unknown[]>(`/runs/${trace}/traces`),
    enabled: Boolean(trace),
  });
  return (
    <>
      {!w.runs.length && (
        <Empty title="每次创作都有迹可循">任务进度、审校发现、上下文来源与恢复操作会出现在这里。</Empty>
      )}
      {w.runs.map((r) => (
        <section className="run-card" key={r.id}>
          <div className="section-tools">
            <div>
              <span className={`badge ${r.status}`}>{statusLabels[r.status]}</span>
              <h3>{taskLabels[r.kind]}</h3>
            </div>
            <time>{new Date(r.createdAt).toLocaleString()}</time>
          </div>
          <p>
            {taskLabels[r.step] ?? r.step} {r.kind === 'write' && `· ${r.progress}/${r.count} 章`}
          </p>
          {r.error && <div className="notice">{r.error}</div>}
          {r.result != null && (
            <details open={r.status === 'awaiting_approval'}>
              <summary>查看结果与审校意见</summary>
              <StructuredResult value={r.result} />
            </details>
          )}
          {typeof r.checkpoint.text === 'string' && (
            <details>
              <summary>已保存的场景草稿</summary>
              <pre className="prose-preview">{r.checkpoint.text}</pre>
              <button
                className="secondary"
                onClick={() =>
                  void action(async () => {
                    await navigator.clipboard.writeText(String(r.checkpoint.text));
                  }, '草稿已复制')
                }
              >
                复制草稿
              </button>
            </details>
          )}
          <div className="inline wrap">
            {['queued', 'running'].includes(r.status) && (
              <button
                className="secondary"
                onClick={() => void action(() => send(`/runs/${r.id}/control`, { action: 'pause' }))}
              >
                在检查点暂停
              </button>
            )}
            {['paused', 'failed'].includes(r.status) && (
              <button
                className="secondary"
                onClick={() => void action(() => send(`/runs/${r.id}/control`, { action: 'resume' }))}
              >
                恢复任务
              </button>
            )}
            {!['completed', 'cancelled'].includes(r.status) && (
              <button
                className="text-button"
                onClick={() => void action(() => send(`/runs/${r.id}/control`, { action: 'cancel' }))}
              >
                取消
              </button>
            )}
            {r.status === 'awaiting_approval' && (
              <button
                className="primary"
                onClick={() =>
                  void action(() => send(`/runs/${r.id}/approve`, { revision: w.project.revision }))
                }
              >
                确认方案
              </button>
            )}
            {r.status === 'completed' && ['rewrite', 'polish'].includes(r.kind) && (
              <button
                className="primary"
                onClick={() =>
                  void action(
                    () => send(`/runs/${r.id}/apply-revision`, { revision: w.project.revision }),
                    '修订已保存为新稿，请重新收录',
                  )
                }
              >
                采用修订建议
              </button>
            )}
            <button className="text-button" onClick={() => setTrace(r.id)}>
              上下文与运行记录
              <ArrowUpRight size={14} />
            </button>
          </div>
        </section>
      ))}
      {trace && (
        <Modal title="上下文证据与运行记录" close={() => setTrace(null)}>
          <p className="muted">包括实际模型、提示词版本、预算、采用的资料与来源版本。仅保存在本机。</p>
          <pre className="json-view">{JSON.stringify(traces.data, null, 2)}</pre>
        </Modal>
      )}
    </>
  );
}
export function SettingsPanel({ action }: { action: Action }) {
  const config = useQuery({ queryKey: ['config'], queryFn: () => api<AppConfig>('/config') });
  const models = useQuery({
    queryKey: ['models'],
    queryFn: () => api<{ models: { id: string }[]; selected: unknown }>('/models'),
    retry: false,
    refetchInterval: 30000,
  });
  const [form, set] = useState<AppConfig>();
  useEffect(() => {
    if (config.data) set(config.data);
  }, [config.data]);
  if (!form) return <p>正在读取配置…</p>;
  return (
    <form
      className="settings-form"
      onSubmit={(e) => {
        e.preventDefault();
        void action(() => send('/config', form, 'PUT'), '设置已保存，新任务会使用新配置');
      }}
    >
      <div className="settings-heading">
        <Settings2 size={22} />
        <div>
          <h3>模型服务</h3>
          <p>OpenAI 兼容 API：LM Studio、Ollama、vLLM、DeepSeek、OpenAI 等均可接入。</p>
        </div>
      </div>
      <Field label="API 地址（含 /v1）" hint="例如 http://127.0.0.1:1234/v1 或 https://api.deepseek.com/v1">
        <input
          value={form.model.baseUrl}
          onChange={(e) => set({ ...form, model: { ...form.model, baseUrl: e.target.value } })}
        />
      </Field>
      <Field label="API Key（本地服务可留空）">
        <input
          type="password"
          autoComplete="off"
          value={form.model.apiKey}
          onChange={(e) => set({ ...form, model: { ...form.model, apiKey: e.target.value } })}
        />
      </Field>
      <Field label="主模型标识">
        <input
          list="loaded-models"
          value={form.model.identifier}
          onChange={(e) => set({ ...form, model: { ...form.model, identifier: e.target.value } })}
        />
        <datalist id="loaded-models">
          {models.data?.models.map((m) => (
            <option key={m.id} value={m.id} />
          ))}
        </datalist>
      </Field>
      {models.isError && <div className="notice">模型服务未连接：{models.error.message}</div>}
      <div className="form-grid">
        <Field label="上下文使用上限">
          <input
            type="number"
            min={2048}
            value={form.model.contextCap}
            onChange={(e) => set({ ...form, model: { ...form.model, contextCap: Number(e.target.value) } })}
          />
        </Field>
        <Field label="单次输出上限（tokens）">
          <input
            type="number"
            min={128}
            value={form.model.outputTokens}
            onChange={(e) => set({ ...form, model: { ...form.model, outputTokens: Number(e.target.value) } })}
          />
        </Field>
        <Field label="创作温度">
          <input
            type="number"
            step="0.1"
            min={0}
            max={2}
            value={form.model.temperature}
            onChange={(e) => set({ ...form, model: { ...form.model, temperature: Number(e.target.value) } })}
          />
        </Field>
        <Field label="分析温度">
          <input
            type="number"
            step="0.1"
            min={0}
            max={2}
            value={form.model.analysisTemperature}
            onChange={(e) =>
              set({ ...form, model: { ...form.model, analysisTemperature: Number(e.target.value) } })
            }
          />
        </Field>
        <Field label="思考模式">
          <select
            value={form.model.reasoning}
            onChange={(e) =>
              set({ ...form, model: { ...form.model, reasoning: e.target.value as 'off' | 'default' } })
            }
          >
            <option value="off">输出时剥离思考区</option>
            <option value="default">模型默认</option>
          </select>
        </Field>
        <Field label="结构化输出方式">
          <select
            value={form.model.responseFormat}
            onChange={(e) =>
              set({
                ...form,
                model: {
                  ...form.model,
                  responseFormat: e.target.value as AppConfig['model']['responseFormat'],
                },
              })
            }
          >
            <option value="json_object">JSON 模式（兼容性最好）</option>
            <option value="json_schema">JSON Schema 严格模式</option>
            <option value="prompt">仅提示词约束</option>
          </select>
        </Field>
        <Field label="任务超时（分钟）">
          <input
            type="number"
            min={1}
            max={60}
            value={form.model.timeoutMs / 60000}
            onChange={(e) =>
              set({ ...form, model: { ...form.model, timeoutMs: Number(e.target.value) * 60000 } })
            }
          />
        </Field>
      </div>
      <div className="settings-heading">
        <Search size={22} />
        <div>
          <h3>长期记忆检索</h3>
          <p>Embedding 不可用时，自动降级为结构化和全文检索并记录原因。</p>
        </div>
      </div>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={form.embedding.enabled}
          onChange={(e) => set({ ...form, embedding: { ...form.embedding, enabled: e.target.checked } })}
        />
        启用语义检索（使用同一 API 地址）
      </label>
      <Field label="Embedding 模型标识">
        <input
          list="embedding-models"
          value={form.embedding.identifier}
          onChange={(e) => set({ ...form, embedding: { ...form.embedding, identifier: e.target.value } })}
        />
        <datalist id="embedding-models">
          {models.data?.models.map((m) => (
            <option key={m.id} value={m.id} />
          ))}
        </datalist>
      </Field>
      <div className="form-grid">
        <Field label="技术重试次数">
          <input
            type="number"
            min={0}
            max={5}
            value={form.worker.retries}
            onChange={(e) => set({ ...form, worker: { ...form.worker, retries: Number(e.target.value) } })}
          />
        </Field>
        <Field label="每章自动修订轮数">
          <input
            type="number"
            min={0}
            max={5}
            value={form.worker.revisionRounds}
            onChange={(e) =>
              set({ ...form, worker: { ...form.worker, revisionRounds: Number(e.target.value) } })
            }
          />
        </Field>
      </div>
      <footer>
        <button
          type="button"
          className="secondary"
          onClick={() => void action(() => send('/backup', {}), 'SQLite 一致性备份已保存到本机数据目录')}
        >
          <Download size={16} />
          备份所有作品
        </button>
        <button className="primary">
          <Save size={16} />
          保存设置
        </button>
      </footer>
    </form>
  );
}

function ProposalEditor({
  run,
  revision,
  action,
  close,
}: {
  run: Run;
  revision: number;
  action: Action;
  close: () => void;
}) {
  const [value, setValue] = useState(run.result);
  const contract = run.kind === 'blueprint' ? blueprintSchema : volumeSchema;
  return (
    <Modal title="调整创作方案" close={close}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void action(async () => {
            const result = contract.parse(value);
            await send(`/runs/${run.id}/proposal`, { revision, result }, 'PUT');
            close();
          }, '方案已保存，确认后才会采用');
        }}
      >
        <p className="muted">可直接修改人物、规则、分卷与章节数。保存后仍需确认。</p>
        <SchemaForm
          schema={z.toJSONSchema(contract) as FormSchema}
          value={value}
          change={setValue}
          labels={resultLabels}
        />
        <footer>
          <button type="button" className="secondary" onClick={close}>
            取消
          </button>
          <button className="primary">保存方案</button>
        </footer>
      </form>
    </Modal>
  );
}
