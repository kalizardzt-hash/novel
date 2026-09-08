import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { dataDirectory, readConfig } from '../packages/infrastructure/src/config.ts';
const source = process.argv.slice(2).find((arg) => arg !== '--');
if (!source) throw new Error('用法：pnpm restore -- /absolute/path/backup.sqlite');
const directory = dataDirectory();
mkdirSync(directory, { recursive: true, mode: 0o700 });
for (const name of ['worker-health.json', 'server-health.json']) {
  const health = path.join(directory, name);
  if (!existsSync(health)) continue;
  const value = JSON.parse(readFileSync(health, 'utf8'));
  try {
    process.kill(value.pid, 0);
    throw new Error('请先停止应用及 Worker 后恢复');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
  }
}
const config = readConfig();
let online = false;
try {
  const response = await fetch(`http://${config.host}:${config.port}/api/v1/health`, {
    signal: AbortSignal.timeout(1500),
  });
  online = response.ok;
} catch {
  /* A stopped local service is expected during restoration. */
}
if (online) throw new Error('检测到正在运行的服务，请停止后恢复');
const destination = path.join(directory, 'novel.sqlite');
if (path.resolve(source) === destination) throw new Error('备份路径不能是当前数据库');
const backup = new Database(path.resolve(source), { readonly: true });
if (
  backup.pragma('integrity_check', { simple: true }) !== 'ok' ||
  (backup.pragma('foreign_key_check') as unknown[]).length
)
  throw new Error('备份未通过完整性检查');
backup.prepare('SELECT version FROM migrations').all();
const temporary = destination + `.restore-${Date.now()}`;
// SQLite backup includes any source WAL; never copy only the main database file.
await backup.backup(temporary);
backup.close();
let preserved: string | undefined;
if (existsSync(destination)) {
  const previous = new Database(destination);
  preserved = destination + `.before-restore-${Date.now()}`;
  await previous.backup(preserved);
  previous.close();
}
for (const suffix of ['-wal', '-shm']) if (existsSync(destination + suffix)) unlinkSync(destination + suffix);
renameSync(temporary, destination);
console.log(JSON.stringify({ restored: destination, previousBackup: preserved }));
