import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readConfig } from '../packages/infrastructure/src/config.ts';
const dev = process.argv.includes('--dev');
if (!dev && !existsSync('apps/web/dist/index.html')) throw new Error('请先运行 pnpm build');
const children: ChildProcess[] = [];
let stopping = false;
function start(args: string[]) {
  const child = spawn(process.execPath, ['--import', 'tsx', ...args], { stdio: 'inherit', detached: true });
  children.push(child);
  child.once('exit', (code) => {
    if (!stopping) shutdown(code ?? 1);
  });
}
function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children)
    if (child.pid && child.exitCode === null) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ESRCH') console.error(e);
      }
    }
  const timer = setTimeout(() => {
    for (const child of children)
      if (child.pid && child.exitCode === null) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {}
      }
    process.exit(code);
  }, 10000);
  Promise.all(
    children.map((c) =>
      c.exitCode !== null ? Promise.resolve() : new Promise((resolve) => c.once('exit', resolve)),
    ),
  ).then(() => {
    clearTimeout(timer);
    process.exit(code);
  });
}
process.once('SIGINT', () => shutdown());
process.once('SIGTERM', () => shutdown());
start(['apps/server/src/main.ts']);
start(['apps/worker/src/main.ts']);
if (dev) start(['node_modules/vite/bin/vite.js', '--config', 'apps/web/vite.config.ts']);
console.log(`\n见山 · 小说工作台  http://127.0.0.1:${dev ? 5173 : readConfig().port}\n`);
