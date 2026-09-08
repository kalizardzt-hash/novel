import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { openStore, createRunner } from '../../../packages/infrastructure/src/runtime.ts';
import { dataDirectory, readConfig } from '../../../packages/infrastructure/src/config.ts';
const owner = randomUUID();
const store = openStore();
const shutdown = new AbortController();
let active: AbortController | undefined;
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    shutdown.abort();
    active?.abort(new Error('Worker 正在关闭，检查点保留'));
  });
try {
  while (!shutdown.signal.aborted) {
    const config = readConfig();
    writeFileSync(
      path.join(dataDirectory(), 'worker-health.json'),
      JSON.stringify({ pid: process.pid, owner, heartbeat: new Date().toISOString() }),
      { mode: 0o600 },
    );
    const run = store.claim(owner, config.worker.leaseMs);
    if (!run) {
      await delay(config.worker.pollMs, undefined, { signal: shutdown.signal }).catch(() => {});
      continue;
    }
    active = new AbortController();
    const heartbeat = setInterval(
      () => {
        try {
          if (!store.heartbeat(run.id, owner, config.worker.leaseMs)) active?.abort(new Error('租约丢失'));
          if (store.getRun(run.id).request === 'cancel') active?.abort(new Error('用户取消'));
          writeFileSync(
            path.join(dataDirectory(), 'worker-health.json'),
            JSON.stringify({ pid: process.pid, owner, runId: run.id, heartbeat: new Date().toISOString() }),
            { mode: 0o600 },
          );
        } catch (e) {
          active?.abort(e);
        }
      },
      Math.min(1000, Math.floor(config.worker.leaseMs / 3)),
    );
    try {
      await createRunner(store, config).execute(run.id, owner, active.signal);
    } catch (e) {
      // 租约丢失等持久层错误可能在收尾写入时再次抛出；Worker 必须存活，
      // 任务由 claim() 的恢复逻辑转为 paused，等待用户处理。
      console.error(`任务 ${run.id} 执行异常：`, e instanceof Error ? e.message : String(e));
    } finally {
      clearInterval(heartbeat);
      active = undefined;
    }
  }
} finally {
  store.close();
}
