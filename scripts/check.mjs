import { readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
for (const folder of ['src', 'test', 'scripts']) {
  for (const name of readdirSync(folder).filter(n => n.endsWith('.mjs'))) execFileSync(process.execPath, ['--check', join(folder, name)], { stdio: 'inherit' });
}
for (const file of ['package.json', 'schemas/policy.schema.json', 'schemas/manifest.schema.json', 'examples/ghostbound.policy.json']) JSON.parse(readFileSync(file, 'utf8'));
console.log('Syntax and JSON checks passed');
