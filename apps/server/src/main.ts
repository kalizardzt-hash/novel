import { buildApp } from './app.ts';
import { openStore } from '../../../packages/infrastructure/src/runtime.ts';
import { readConfig } from '../../../packages/infrastructure/src/config.ts';
import { dataDirectory } from '../../../packages/infrastructure/src/config.ts';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
const store = openStore();
const app = await buildApp(store, { logger: true });
const config = readConfig();
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, async () => {
    await app.close();
    store.close();
    process.exit(0);
  });
await app.listen({ host: config.host, port: config.port });
writeFileSync(
  path.join(dataDirectory(), 'server-health.json'),
  JSON.stringify({ pid: process.pid, port: config.port }),
  { mode: 0o600 },
);
