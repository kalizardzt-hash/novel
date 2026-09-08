import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { PROMPT_VERSION } from '../../prompts/src/index.ts';
/** Source fingerprint at evaluation start, independent of Git availability. No user data is hashed. */
export function sourceReceipt() {
  const files = ['package.json', 'pnpm-lock.yaml'];
  function visit(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory() && !['node_modules', 'dist'].includes(entry.name)) visit(file);
      else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) files.push(file);
    }
  }
  for (const folder of ['apps', 'packages', 'scripts']) visit(folder);
  const hash = createHash('sha256');
  for (const file of files.sort()) hash.update(file).update('\0').update(readFileSync(file)).update('\0');
  return {
    sha256: hash.digest('hex'),
    sourceFiles: files.length,
    promptVersion: PROMPT_VERSION,
    node: process.version,
    createdAt: new Date().toISOString(),
  };
}
