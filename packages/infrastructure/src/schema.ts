import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
export const projectTable = sqliteTable('projects', {
  id: text('id').primaryKey(),
  revision: integer('revision').notNull(),
  payload: text('payload').notNull(),
  updatedAt: text('updated_at').notNull(),
});
export const migrations = [
  // Append-only migrations; existing data remains valid across application upgrades.
  {
    version: 1,
    sql: `
CREATE TABLE projects (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE entities (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), payload TEXT NOT NULL);
CREATE INDEX entities_project ON entities(project_id);
CREATE TABLE chapters (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), number INTEGER NOT NULL, revision INTEGER NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(project_id,number));
CREATE INDEX chapters_project ON chapters(project_id,number);
CREATE TABLE revisions (id TEXT PRIMARY KEY, chapter_id TEXT NOT NULL REFERENCES chapters(id), revision INTEGER NOT NULL, payload TEXT NOT NULL, UNIQUE(chapter_id,revision));
CREATE TABLE memories (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), chapter_id TEXT NOT NULL REFERENCES chapters(id), chapter_revision INTEGER NOT NULL, chapter_number INTEGER NOT NULL, valid INTEGER NOT NULL, payload TEXT NOT NULL);
CREATE INDEX memory_lookup ON memories(project_id,valid,chapter_number);
CREATE TABLE summaries (chapter_id TEXT PRIMARY KEY REFERENCES chapters(id), revision INTEGER NOT NULL, summary TEXT NOT NULL);
CREATE TABLE impacts (chapter_id TEXT NOT NULL REFERENCES chapters(id), source_id TEXT NOT NULL, reason TEXT NOT NULL, resolved INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(chapter_id,source_id));
CREATE TABLE runs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), key TEXT NOT NULL, status TEXT NOT NULL, owner TEXT, lease_until INTEGER, payload TEXT NOT NULL, UNIQUE(project_id,key));
CREATE INDEX runs_status ON runs(status);
CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL REFERENCES projects(id), run_id TEXT, type TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX events_project ON events(project_id,id);
CREATE TABLE traces (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), payload TEXT NOT NULL);
CREATE TABLE vectors (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), chapter_id TEXT NOT NULL REFERENCES chapters(id), revision INTEGER NOT NULL, identity TEXT NOT NULL, text TEXT NOT NULL, vector BLOB NOT NULL);
CREATE INDEX vectors_project ON vectors(project_id,identity);
CREATE VIRTUAL TABLE search_index USING fts5(id UNINDEXED, project_id UNINDEXED, source UNINDEXED, content, tokenize='unicode61');
`,
  },
  {
    version: 2,
    sql: `
CREATE TABLE digests (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), key TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(project_id,key));
CREATE INDEX digests_project ON digests(project_id);
`,
  },
];
