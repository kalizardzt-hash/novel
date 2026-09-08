import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { SqliteStoryStore } from '../packages/infrastructure/src/store.ts';
import { projectInputSchema } from '../packages/domain/src/index.ts';
const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
function folder() {
  const d = mkdtempSync(path.join(os.tmpdir(), 'novel-restore-'));
  directories.push(d);
  return d;
}
function restore(directory: string, source: string) {
  return execFileSync(process.execPath, ['--import', 'tsx', 'scripts/restore.ts', '--', source], {
    env: { ...process.env, NOVEL_DATA_DIR: directory, NOVEL_PORT: '45991' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
it('SQLite 恢复读取源 WAL，并为被替换作品保留一致性备份', () => {
  const directory = folder();
  const source = path.join(directory, 'backup.sqlite');
  const original = new SqliteStoryStore(path.join(directory, 'novel.sqlite'));
  original.createProject(projectInputSchema.parse({ title: '原有作品' }));
  original.close();
  const incoming = new SqliteStoryStore(source);
  try {
    incoming.createProject(projectInputSchema.parse({ title: 'WAL 中的新作品' }));
    const result = JSON.parse(restore(directory, source));
    const current = new Database(result.restored, { readonly: true });
    const previous = new Database(result.previousBackup, { readonly: true });
    expect(JSON.stringify(current.prepare('SELECT payload FROM projects').all())).toContain('WAL 中的新作品');
    expect(JSON.stringify(previous.prepare('SELECT payload FROM projects').all())).toContain('原有作品');
    current.close();
    previous.close();
  } finally {
    incoming.close();
  }
});
it('运行中服务或损坏备份会阻止替换', () => {
  const directory = folder();
  const source = path.join(directory, 'bad.sqlite');
  writeFileSync(source, 'not sqlite');
  writeFileSync(path.join(directory, 'server-health.json'), JSON.stringify({ pid: process.pid }));
  expect(() => restore(directory, source)).toThrow();
  expect(readdirSync(directory)).not.toContain('novel.sqlite');
  rmSync(path.join(directory, 'server-health.json'));
  expect(() => restore(directory, source)).toThrow();
  expect(readFileSync(source, 'utf8')).toBe('not sqlite');
});
