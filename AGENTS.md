# 见山工作区

Read `docs/ARCHITECTURE.md` before changing memory, context construction, model adapters, or durable task execution.

- Domain and application code depend on ports, never on React, Fastify, SQLite, or model provider implementations.
- A manuscript save creates a new revision. Canonical chapter, memory, summary, and run checkpoint commit in one transaction under a live lease and expected project revision.
- Changes to source text invalidate derived memories. Preserve failed runs and provisional drafts; report failures explicitly.
- Model behavior tests use real model services only through explicit evaluation commands. Unit/browser tests use isolated databases and test fixtures.
- Novel data and model configuration live in `.novel/` (or `NOVEL_DATA_DIR`), outside source control. Never commit manuscript content or local model paths from this directory.
- After behavior changes run the relevant tests, then `pnpm check`, `pnpm test`, and `pnpm build`; frontend changes also require `pnpm test:e2e`.
- Report synthetic capacity tests, model smoke tests, continuous chapter runs, and human literary review as separate evidence levels.
