import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BookOpen,
  Feather,
  Users,
  Globe2,
  Network,
  Clock3,
  Layers3,
  Brain,
  Activity,
  Settings,
  Plus,
  ArrowUpRight,
  ArrowRight,
  Sparkles,
  ChevronDown,
  PanelRightClose,
  PanelRightOpen,
  Send,
  CheckCircle2,
  X,
  Download,
  Leaf,
  Mountain,
  Menu,
} from 'lucide-react';
import type { Project, Run, RunEvent, RunInput } from '../../../packages/domain/src/index.ts';
import {
  EntityPanel,
  Manuscript,
  MemoryPanel,
  Outline,
  ProjectForm,
  RelationshipGraph,
  RunsPanel,
  SettingsPanel,
  type Action,
} from './components.tsx';
import { api, send, statusLabels, taskLabels, type Workspace } from './api.ts';
type View =
  | 'overview'
  | 'manuscript'
  | 'outline'
  | 'characters'
  | 'world'
  | 'graph'
  | 'timeline'
  | 'threads'
  | 'memory'
  | 'runs'
  | 'settings';
const views = [
  { id: 'overview', label: '作品概览', icon: BookOpen, group: '创作' },
  { id: 'manuscript', label: '正文写作', icon: Feather, group: '创作' },
  { id: 'outline', label: '故事蓝图', icon: Layers3, group: '创作' },
  { id: 'characters', label: '人物与关系', icon: Users, group: '故事世界' },
  { id: 'world', label: '世界观设定', icon: Globe2, group: '故事世界' },
  { id: 'graph', label: '关系图谱', icon: Network, group: '故事世界' },
  { id: 'timeline', label: '故事时间线', icon: Clock3, group: '故事世界' },
  { id: 'threads', label: '伏笔与回收', icon: Leaf, group: '故事世界' },
  { id: 'memory', label: '故事记忆', icon: Brain, group: '工作台' },
  { id: 'runs', label: '创作记录', icon: Activity, group: '工作台' },
  { id: 'settings', label: '模型与设置', icon: Settings, group: '工作台' },
] as const;
const subtitles: Record<View, string> = {
  overview: '让一个念头，长成一个世界。',
  manuscript: '写下此刻，让人物走向下一步。',
  outline: '故事的方向，与每一段旅程。',
  characters: '每个人都有自己的理由。',
  world: '让规则有代价，让世界有来处。',
  graph: '关系让孤立的人物成为故事。',
  timeline: '发生的顺序，与被讲述的顺序。',
  threads: '记住每一次许诺，照应每一个回声。',
  memory: '重要的事实，都有迹可循。',
  runs: '从灵感到定稿，每一步都可回看。',
  settings: '你的模型、资料与创作节奏。',
};
export function App() {
  const client = useQueryClient();
  const [projectId, setProjectId] = useState(localStorage.getItem('novel-project') ?? '');
  const [view, setView] = useState<View>('overview');
  const [selected, setSelected] = useState('');
  const [create, setCreate] = useState(false);
  const [editProject, setEditProject] = useState(false);
  const [assistant, setAssistant] = useState(true);
  const [mobileNav, setMobileNav] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(0);
  const [preview, setPreview] = useState('');
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api<Project[]>('/projects') });
  const workspace = useQuery({
    queryKey: ['workspace', projectId],
    queryFn: () => api<Workspace>(`/projects/${projectId}`),
    enabled: Boolean(projectId),
    refetchInterval: 5000,
  });
  const health = useQuery({
    queryKey: ['health'],
    queryFn: () => api<{ status: string; worker: { heartbeat: string } | null; model: string }>('/health'),
    refetchInterval: 10000,
  });
  const models = useQuery({
    queryKey: ['models'],
    queryFn: () => api<{ selected: { id?: string; contextLength?: number; error?: string } }>('/models'),
    retry: false,
    refetchInterval: 30000,
  });
  useEffect(() => {
    if (!projectId && projects.data?.length) choose(projects.data[0]!.id);
  }, [projects.data]);
  // 工作区加载失败时通常是 localStorage 里残留了已删除作品的 id；
  // 清掉它，避免侧栏点了任何视图都只换标题、不换内容。
  useEffect(() => {
    if (projectId && workspace.isError) {
      localStorage.removeItem('novel-project');
      setProjectId('');
    }
  }, [projectId, workspace.isError]);
  const choose = (id: string) => {
    setProjectId(id);
    localStorage.setItem('novel-project', id);
    setSelected('');
    setPreview('');
  };
  const action: Action = async (work, success) => {
    setBusy((n) => n + 1);
    try {
      await work();
      await client.invalidateQueries();
      if (success) setNotice({ text: success, error: false });
    } catch (e) {
      setNotice({ text: e instanceof Error ? e.message : String(e), error: true });
    } finally {
      setBusy((n) => n - 1);
    }
  };
  const run = (input: Partial<RunInput> & { kind: RunInput['kind'] }) => {
    if (!projectId) {
      setCreate(true);
      return;
    }
    void action(async () => {
      await send<Run>(`/projects/${projectId}/runs`, input);
      setPreview('');
      if (['review', 'extract', 'polish', 'rewrite', 'intent'].includes(input.kind)) setView('runs');
    }, '任务已加入本地队列');
  };
  useEffect(() => {
    if (!projectId) return;
    const events = new EventSource(`/api/v1/projects/${projectId}/events?live=1`);
    events.onmessage = (event) => {
      const data = JSON.parse(event.data) as RunEvent;
      if (data.type === 'generation.preview' || data.type === 'generation.interrupted')
        setPreview((data.data as { text: string }).text);
      else if (data.type !== 'task.retry')
        void client.invalidateQueries({ queryKey: ['workspace', projectId] });
      if (['digest.saved', 'chapter.accepted'].includes(data.type))
        void client.invalidateQueries({ queryKey: ['memory', projectId] });
    };
    return () => events.close();
  }, [projectId, client]);
  useEffect(() => {
    if (notice && !notice.error) {
      const t = setTimeout(() => setNotice(null), 4500);
      return () => clearTimeout(t);
    }
  }, [notice]);
  const w = workspace.data;
  const active = w?.runs.find((r) => ['running', 'queued', 'awaiting_approval'].includes(r.status));
  const connected = Boolean(models.data?.selected.id);
  const workerAlive = health.data?.worker && Date.now() - Date.parse(health.data.worker.heartbeat) < 45000;
  // 没有作品时只允许停在概览与设置；点别的侧栏入口会被回弹到概览，
  // 由 Welcome 引导新建作品，而不是看起来像"页面不跳转"。
  useEffect(() => {
    if (!w && view !== 'overview' && view !== 'settings') setView('overview');
  }, [w, view]);
  const navigate = (target: View) => {
    setView(target);
    setMobileNav(false);
  };
  return (
    <div className={`app ${assistant ? '' : 'assistant-hidden'}`}>
      <aside className={`sidebar ${mobileNav ? 'open' : ''}`}>
        <div className="brand">
          <span className="brand-mark">
            <Mountain size={23} />
          </span>
          <div>
            <strong>见山</strong>
            <span>STORY STUDIO</span>
          </div>
        </div>
        <div className="project-switch">
          <select aria-label="切换作品" value={projectId} onChange={(e) => choose(e.target.value)}>
            <option value="">我的创作空间</option>
            {projects.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
          <ChevronDown size={14} />
          <button aria-label="新建作品" onClick={() => setCreate(true)}>
            <Plus size={16} />
          </button>
        </div>
        <nav>
          {views.map((item, i) => (
            <div key={item.id}>
              {(i === 0 || views[i - 1]!.group !== item.group) && (
                <div className="nav-group">{item.group}</div>
              )}
              <button
                className={`nav-item ${view === item.id ? 'active' : ''}`}
                onClick={() => navigate(item.id)}
              >
                <item.icon size={18} />
                <span>{item.label}</span>
                {item.id === 'runs' && active && <i className="dot" />}
              </button>
            </div>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="local-status">
            <span className={`status-dot ${connected ? 'online' : ''}`} />
            <div>
              <strong>{connected ? '模型服务已连接' : '等待模型服务'}</strong>
              <span>
                {models.data?.selected.contextLength
                  ? `${Math.round(models.data.selected.contextLength / 1024)}K 上下文上限`
                  : 'OpenAI 兼容 API'}
              </span>
            </div>
          </div>
          <p>
            <Leaf size={13} />
            故事留在你的电脑里
          </p>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <button
            className="icon-button mobile-only"
            aria-label="打开导航"
            onClick={() => setMobileNav(!mobileNav)}
          >
            <Menu size={20} />
          </button>
          <div className="breadcrumb">
            创作空间<span>/</span>
            <strong>{w?.project.title ?? '新的故事'}</strong>
          </div>
          <div className="topbar-actions">
            <span className="quiet-status">{busy ? '正在保存…' : '本地工作台'}</span>
            {w && (
              <a className="text-button" href={`/api/v1/projects/${projectId}/export?format=md`}>
                <Download size={15} />
                导出
              </a>
            )}
            <button
              className="icon-button"
              aria-label="切换创作助手"
              onClick={() => setAssistant(!assistant)}
            >
              {assistant ? <PanelRightClose size={19} /> : <PanelRightOpen size={19} />}
            </button>
          </div>
        </header>
        <main className={`main-content view-${view}`}>
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                {view === 'overview' ? 'YOUR NEXT CHAPTER' : 'JIANSHAN / STORY WORKSPACE'}
              </div>
              <h1>{views.find((v) => v.id === view)?.label}</h1>
              <p>{subtitles[view]}</p>
            </div>
            {view === 'overview' && (
              <button className="secondary" onClick={() => (w ? setEditProject(true) : setCreate(true))}>
                {w ? '创作约定' : '新建作品'}
                <ArrowUpRight size={15} />
              </button>
            )}
          </div>
          {projects.isError && <div className="notice">{projects.error.message}</div>}
          {workspace.isError && <div className="notice">{workspace.error.message}</div>}
          {view === 'settings' ? (
            <SettingsPanel action={action} />
          ) : !w ? (
            <Welcome create={() => setCreate(true)} />
          ) : (
            <>
              {view === 'overview' && (
                <Overview workspace={w} navigate={navigate} run={run} edit={() => setEditProject(true)} />
              )}
              {view === 'manuscript' && (
                <Manuscript
                  workspace={w}
                  selected={selected || w.chapters.at(-1)?.id || ''}
                  select={setSelected}
                  action={action}
                  run={run}
                />
              )}
              {view === 'outline' && <Outline workspace={w} run={run} action={action} />}
              {view === 'characters' && (
                <EntityPanel workspace={w} kinds={['character', 'relationship']} action={action} />
              )}
              {view === 'world' && (
                <EntityPanel
                  workspace={w}
                  kinds={['world', 'rule', 'location', 'faction', 'item']}
                  action={action}
                />
              )}
              {view === 'threads' && <EntityPanel workspace={w} kinds={['foreshadowing']} action={action} />}
              {view === 'timeline' && (
                <>
                  <div className="timeline">
                    {w.entities
                      .filter((e) => e.kind === 'event')
                      .sort((a, b) => a.narrativeFrom - b.narrativeFrom)
                      .map((e) => (
                        <div key={e.id}>
                          <i />
                          <span>
                            第 {e.narrativeFrom} 章 · {e.storyTime || '时间未明确'}
                          </span>
                          <h3>{e.name}</h3>
                          <p>{e.description}</p>
                        </div>
                      ))}
                  </div>
                  <EntityPanel workspace={w} kinds={['event']} action={action} />
                </>
              )}
              {view === 'graph' && <RelationshipGraph entities={w.entities} />}
              {view === 'memory' && <MemoryPanel workspace={w} run={run} />}
              {view === 'runs' && <RunsPanel workspace={w} action={action} />}
            </>
          )}
          <div className="page-footer">
            <span>见山 · 在字里行间，建立世界</span>
            <span>LOCAL FIRST</span>
          </div>
        </main>
      </div>
      {assistant && (
        <aside className="assistant">
          <div className="assistant-heading">
            <span className="assistant-symbol">
              <Sparkles size={18} />
            </span>
            <div>
              <strong>创作助手</strong>
              <span>陪你把故事写下去</span>
            </div>
            <span className={`status-dot ${workerAlive ? 'online' : ''}`} />
          </div>
          <div className="assistant-body">
            <div className="assistant-intro">
              <span className="eyebrow">一起写作</span>
              <h3>{w?.project.approved ? '让故事，向前一步。' : '先认识你的故事。'}</h3>
              <p>
                {w?.project.approved
                  ? '我会带着已确认的设定与过往记忆，逐场景推进，审校后再收录。'
                  : '从一个灵感出发，梳理世界、人物和主线。重要方向由你来决定。'}
              </p>
            </div>
            <div className="assistant-steps">
              {[
                ['创作约定', Boolean(w?.project.premise)],
                ['全书蓝图', Boolean(w?.project.approved)],
                ['当前卷纲', Boolean(w && Object.values(w.project.volumes).some((v) => v.approved))],
              ].map(([label, done], i) => (
                <div key={String(label)}>
                  <span className={done ? 'done' : ''}>
                    {done ? <CheckCircle2 size={15} /> : `0${i + 1}`}
                  </span>
                  <strong>{label}</strong>
                </div>
              ))}
            </div>
            <CreativeControls workspace={w} selected={selected || w?.chapters.at(-1)?.id || ''} run={run} />
            {active && (
              <div className="active-task">
                <div>
                  <i className="dot" />
                  <strong>{taskLabels[active.kind]}</strong>
                  <span className="badge">{statusLabels[active.status]}</span>
                </div>
                <p>{taskLabels[active.step] ?? active.step}</p>
                <button className="text-button" onClick={() => navigate('runs')}>
                  查看进度与检查点
                  <ArrowRight size={14} />
                </button>
              </div>
            )}
            {preview && (
              <details className="preview" open>
                <summary>生成预览 · 尚未正式收录</summary>
                <p>{preview.slice(-4000)}</p>
              </details>
            )}
            {!workerAlive && (
              <div className="notice small">
                后台 Worker 尚未连接。使用 pnpm start 同时启动网页与后台执行。
              </div>
            )}
          </div>
          <div className="assistant-note">
            <Brain size={15} />
            <span>
              故事记忆按任务选取
              <br />
              每次创作都能追溯来源
            </span>
          </div>
        </aside>
      )}
      {(create || editProject) && (
        <ProjectForm
          existing={editProject ? w?.project : undefined}
          close={() => {
            setCreate(false);
            setEditProject(false);
          }}
          action={action}
          created={choose}
        />
      )}
      {notice && (
        <div className={`toast ${notice.error ? 'error' : ''}`} role="status">
          <span>{notice.text}</span>
          <button aria-label="关闭提示" onClick={() => setNotice(null)}>
            <X size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
function Welcome({ create }: { create: () => void }) {
  return (
    <>
      <section className="welcome-hero">
        <div>
          <span className="eyebrow">A PLACE FOR YOUR STORIES</span>
          <h2>
            山川与人物，
            <br />
            都从第一句话开始。
          </h2>
          <p>
            为你的长篇小说建立一个安静、可靠的创作空间。
            <br />
            规划世界，认识人物，让每一章有所承接。
          </p>
          <button className="primary" onClick={create}>
            <Plus size={17} />
            创建第一部作品
            <ArrowUpRight size={17} />
          </button>
        </div>
        <div className="mountain-art" aria-hidden="true">
          <div className="sun" />
          <div className="ridge ridge-3" />
          <div className="ridge ridge-2" />
          <div className="ridge ridge-1" />
          <span>山有来处 · 故事有归途</span>
        </div>
      </section>
      <div className="intro-grid">
        {[
          [Globe2, '一个可信的世界', '规则、地理、历史与势力，让故事发生的地方有自己的秩序。'],
          [Users, '一群鲜活的人物', '欲望、秘密、矛盾与成长，每个决定都有来处。'],
          [Feather, '一段持续的创作', '分章推进、审校与记忆，合上电脑后也能接着写。'],
        ].map(([Icon, title, text], i) => {
          const I = Icon as typeof Globe2;
          return (
            <article key={i}>
              <I size={22} />
              <h3>{String(title)}</h3>
              <p>{String(text)}</p>
              <span>0{i + 1}</span>
            </article>
          );
        })}
      </div>
    </>
  );
}
function Overview({
  workspace: w,
  navigate,
  run,
  edit,
}: {
  workspace: Workspace;
  navigate: (view: View) => void;
  run: (input: Partial<RunInput> & { kind: RunInput['kind'] }) => void;
  edit: () => void;
}) {
  const progress = Math.min(100, (w.stats.chars / w.project.targetChars) * 100);
  const last = w.chapters.at(-1);
  return (
    <>
      <section className="project-hero">
        <div>
          <span className="eyebrow">
            {w.project.genre} · {w.project.pov}
          </span>
          <h2>{w.project.title}</h2>
          <p>{w.project.premise || '还没有写下故事的种子。花一点时间，描述你想讲述的故事。'}</p>
          <button
            className="primary"
            onClick={() =>
              last
                ? navigate('manuscript')
                : w.project.approved
                  ? navigate('outline')
                  : run({ kind: 'blueprint' })
            }
          >
            {last ? '回到正文' : w.project.approved ? '展开卷纲' : '规划我的故事'}
            <ArrowRight size={16} />
          </button>
          <button className="text-button" onClick={edit}>
            编辑创作约定
          </button>
        </div>
        <div className="book-emblem">
          <BookOpen size={70} strokeWidth={0.8} />
          <span>未完 · 待续</span>
        </div>
      </section>
      <div className="stats-grid">
        <article>
          <span>已收录正文</span>
          <strong>
            {w.stats.chars.toLocaleString()}
            <small>字</small>
          </strong>
          <div className="progress-track">
            <i style={{ width: `${progress}%` }} />
          </div>
          <p>
            目标 {(w.project.targetChars / 10000).toLocaleString()} 万字 · {progress.toFixed(1)}%
          </p>
        </article>
        <article>
          <span>故事章节</span>
          <strong>
            {w.chapters.length}
            <small>章</small>
          </strong>
          <p>
            {w.chapters.filter((c) => c.status === 'accepted').length} 章已收录 ·{' '}
            {w.chapters.filter((c) => c.status !== 'accepted').length} 章待复核
          </p>
        </article>
        <article>
          <span>世界中的人物</span>
          <strong>
            {w.entities.filter((e) => e.kind === 'character').length}
            <small>人</small>
          </strong>
          <p>每个角色，都有自己的来路</p>
        </article>
      </div>
      {w.impacts.length > 0 && (
        <button className="notice clickable" onClick={() => navigate('memory')}>
          <strong>有 {new Set(w.impacts.map((i) => i.chapterId)).size} 章需要重新核对</strong>
          <span>
            前文或设定已变化，查看影响范围
            <ArrowRight size={15} />
          </span>
        </button>
      )}
      <div className="section-title">
        <h2>构建你的故事世界</h2>
        <span>WORLD & CHARACTERS</span>
      </div>
      <div className="world-shortcuts">
        {(
          [
            {
              view: 'characters',
              icon: Users,
              label: '人物与关系',
              sub: '欲望、矛盾与成长',
              count: w.entities.filter((e) => e.kind === 'character').length,
            },
            {
              view: 'world',
              icon: Globe2,
              label: '世界观设定',
              sub: '规则、历史与日常',
              count: w.entities.filter((e) => ['world', 'rule', 'location', 'faction'].includes(e.kind))
                .length,
            },
            {
              view: 'threads',
              icon: Leaf,
              label: '伏笔与回收',
              sub: '每个承诺，都有回声',
              count: w.entities.filter((e) => e.kind === 'foreshadowing').length,
            },
          ] as const
        ).map((item) => (
          <button key={item.view} onClick={() => navigate(item.view)}>
            <item.icon size={24} />
            <div>
              <h3>{item.label}</h3>
              <p>{item.sub}</p>
            </div>
            <span>{item.count}</span>
            <ArrowUpRight size={16} />
          </button>
        ))}
      </div>
      <div className="section-title">
        <h2>最近的章节</h2>
        <button className="text-button" onClick={() => navigate('manuscript')}>
          全部章节
          <ArrowRight size={15} />
        </button>
      </div>
      <div className="recent-chapters">
        {w.chapters
          .slice(-4)
          .reverse()
          .map((c) => (
            <button key={c.id} onClick={() => navigate('manuscript')}>
              <span className="chapter-index">{String(c.number).padStart(2, '0')}</span>
              <div>
                <h3>{c.title}</h3>
                <span>
                  {c.chars.toLocaleString()} 字 · 第 {c.revision} 版
                </span>
              </div>
              <span className={`badge ${c.status}`}>{statusLabels[c.status]}</span>
              <ArrowUpRight size={16} />
            </button>
          ))}
        {!w.chapters.length && <p className="quiet-empty">此处尚是一张白纸。确认蓝图后，开始第一章。</p>}
      </div>
    </>
  );
}
function CreativeControls({
  workspace: w,
  selected,
  run,
}: {
  workspace?: Workspace;
  selected: string;
  run: (input: Partial<RunInput> & { kind: RunInput['kind'] }) => void;
}) {
  const [instruction, setInstruction] = useState('');
  const [kind, setKind] = useState<RunInput['kind']>('write');
  const [volume, setVolume] = useState(1);
  const [count, setCount] = useState(1);
  return (
    <div className="creative-controls">
      <label className="field">
        <span>这次想推进什么？</span>
        <select
          aria-label="创作任务"
          value={kind}
          onChange={(e) => setKind(e.target.value as RunInput['kind'])}
        >
          {['write', 'blueprint', 'volume', 'polish', 'rewrite', 'review', 'intent', 'audit'].map((k) => (
            <option key={k} value={k}>
              {k === 'intent' ? '自然语言指令 / 资料问答' : taskLabels[k]}
            </option>
          ))}
        </select>
      </label>
      {['write', 'volume'].includes(kind) && (
        <div className="form-grid">
          <label className="field">
            <span>第几卷</span>
            <input
              type="number"
              min={1}
              max={30}
              value={volume}
              onChange={(e) => setVolume(Number(e.target.value))}
            />
          </label>
          {kind === 'write' && (
            <label className="field">
              <span>推进章数</span>
              <input
                type="number"
                min={1}
                max={1000}
                value={count}
                onChange={(e) => setCount(Number(e.target.value))}
              />
            </label>
          )}
        </div>
      )}
      <textarea
        aria-label="创作要求"
        rows={4}
        value={instruction}
        onChange={(e) => setInstruction(e.target.value)}
        placeholder="补充你的想法，或直接使用已确认的规划…"
      />
      <button
        className="primary full"
        onClick={() =>
          run({
            kind,
            instruction,
            volume,
            count,
            ...(['polish', 'rewrite', 'review', 'intent'].includes(kind) && selected
              ? { chapterId: selected }
              : {}),
          })
        }
      >
        <Sparkles size={16} />
        {kind === 'intent' ? '理解我的想法' : '开始这次创作'}
        <Send size={15} />
      </button>
      {kind === 'write' && !w?.project.volumes[String(volume)]?.approved && (
        <p className="control-hint">开始正文前，需要确认全书蓝图与第 {volume} 卷卷纲。</p>
      )}
    </div>
  );
}
