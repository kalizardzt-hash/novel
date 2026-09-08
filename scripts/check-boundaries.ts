import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
  );
}
const failures: string[] = [];
// 领域与应用层只能依赖彼此和自身端口，不得反向依赖实现细节。
for (const dir of ['packages/domain/src', 'packages/application/src'])
  for (const file of walk(dir).filter((f) => f.endsWith('.ts'))) {
    const text = readFileSync(file, 'utf8');
    if (/from\s+['"][^'"]*(?:infrastructure|apps\/|better-sqlite3|lmstudio|react|fastify)/.test(text))
      failures.push(file);
  }
// 表现层不得直接依赖基础设施实现；配置契约等共享类型放在应用层。
for (const file of walk('apps/web/src').filter((f) => f.endsWith('.ts') || f.endsWith('.tsx')))
  if (/from\s+['"][^'"]*infrastructure\//.test(readFileSync(file, 'utf8'))) failures.push(file);
if (failures.length) throw new Error('依赖方向违规：' + failures.join(', '));
console.log('模块依赖方向检查通过');
