import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jsonBytes } from '../src/common.mjs';
import { main } from '../src/cli.mjs';
import { run } from '../src/mirror.mjs';
import { readView, resolveView } from '../src/view.mjs';
import { setScannerProcessOverride } from '../src/secrets.mjs';

function git(repo, args) { return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim(); }
function fixture(t) {
  const base = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), 'ghostbound-output-'))); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const repo = join(base, 'source'); fs.mkdirSync(repo); git(repo, ['init']); git(repo, ['config', 'user.name', 'Output Test']); git(repo, ['config', 'user.email', 'output@example.invalid']); fs.writeFileSync(join(repo, 'README.md'), 'output\n'); git(repo, ['add', 'README.md']); git(repo, ['commit', '-m', 'output']);
  const policy = join(base, 'policy.json'); fs.writeFileSync(policy, jsonBytes({ schema: 'ghostbound.policy/v1', include: [{ path: 'README.md' }] }));
  const out = join(base, 'mirror'); const viewFile = join(base, 'view.json'); fs.writeFileSync(viewFile, jsonBytes({ schema: 'ghostbound.view/v1', name: 'output', source: { repo, ref: 'HEAD' }, policy, out }));
  const restore = setScannerProcessOverride((args) => args[0] === 'version' ? { status: 0, stdout: Buffer.from('8.30.1'), stderr: Buffer.alloc(0) } : { status: 0, stdout: Buffer.from('[]'), stderr: Buffer.alloc(0) }); t.after(restore);
  return { base, repo, policy, out, viewFile };
}
function cliJson(argv) { let output = ''; const original = console.log; console.log = value => { output = String(value); }; try { main(argv); } finally { console.log = original; } return JSON.parse(output); }

for (const command of ['plan', 'materialize']) test(`${command} exposes only the public result contract`, t => {
  const f = fixture(t); const view = resolveView(readView(f.viewFile)); const result = cliJson([command, '--repo', view.source.repo, '--commit', view.source.commit, '--policy', view.policy, '--out', view.out]);
  assert.deepEqual(Object.keys(result).sort(), ['applied', 'changes', 'disclosure', 'mirror']);
  assert.equal(Object.hasOwn(result, 'policyBytes'), false); assert.equal(Object.hasOwn(result, 'manifest'), false); assert.equal(Object.hasOwn(result, 'source'), false);
  assert.equal(JSON.stringify(result).includes(f.base), false);
});

test('status keeps internal plan state without widening the public run result', t => {
  const f = fixture(t); const view = resolveView(readView(f.viewFile)); const result = run({ repo: view.source.repo, commit: view.source.commit, policy: view.policy, out: view.out });
  assert.deepEqual(Object.keys(result).sort(), ['applied', 'changes', 'disclosure', 'mirror']);
  assert.equal(JSON.stringify(result).includes('Buffer'), false); assert.equal(JSON.stringify(result).includes(f.base), false);
});
