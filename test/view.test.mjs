import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jsonBytes } from '../src/common.mjs';
import { readView, resolveView } from '../src/view.mjs';
import { parseArgs } from '../src/cli.mjs';

function git(repo, args) { return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim(); }
function fixture(t) {
  const base = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), 'ghostbound-view-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const repo = join(base, 'source'); fs.mkdirSync(repo); git(repo, ['init']); git(repo, ['config', 'user.name', 'View Test']); git(repo, ['config', 'user.email', 'view@example.invalid']);
  fs.writeFileSync(join(repo, 'README.md'), 'view\n'); git(repo, ['add', 'README.md']); git(repo, ['commit', '-m', 'view']);
  const policy = join(base, 'policy.json'); fs.writeFileSync(policy, jsonBytes({ schema: 'ghostbound.policy/v1', include: [{ path: 'README.md' }] }));
  const view = join(base, 'views', 'chatgpt.json'); fs.mkdirSync(join(base, 'views'));
  fs.writeFileSync(view, jsonBytes({ schema: 'ghostbound.view/v1', name: 'chatgpt', source: { repo: '../source', ref: 'HEAD' }, policy: '../policy.json', out: '../mirror' }));
  return { base, repo, policy, view, commit: git(repo, ['rev-parse', 'HEAD']) };
}

test('view resolves relative paths and HEAD to a full commit', t => {
  const f = fixture(t); const view = resolveView(readView(f.view));
  assert.equal(view.name, 'chatgpt'); assert.equal(view.source.repo, f.repo); assert.equal(view.policy, f.policy); assert.equal(view.out, join(f.base, 'mirror')); assert.equal(view.source.commit, f.commit);
});

test('view accepts absolute paths and full OID', t => {
  const f = fixture(t); fs.writeFileSync(f.view, jsonBytes({ schema: 'ghostbound.view/v1', name: 'absolute', source: { repo: f.repo, ref: f.commit }, policy: f.policy, out: join(f.base, 'absolute-mirror') }));
  assert.equal(resolveView(readView(f.view)).source.commit, f.commit);
});

for (const value of [
  '{"schema":"ghostbound.view/v1","name":"x","source":{"repo":"../source","ref":"HEAD"},"policy":"../policy.json","out":"../mirror","name":"y"}',
  JSON.stringify({ schema: 'ghostbound.view/v1', name: 'bad/name', source: { repo: '../source', ref: 'HEAD' }, policy: '../policy.json', out: '../mirror' }),
  JSON.stringify({ schema: 'ghostbound.view/v1', name: 'x', source: { repo: '../source', ref: 'main' }, policy: '../policy.json', out: '../mirror' }),
]) test('invalid view is rejected: ' + value.slice(0, 35), t => { const f = fixture(t); fs.writeFileSync(f.view, value); assert.throws(() => readView(f.view)); });

test('view rejects unknown keys and CLI mixing', t => {
  const f = fixture(t); fs.writeFileSync(f.view, jsonBytes({ schema: 'ghostbound.view/v1', name: 'x', source: { repo: '../source', ref: 'HEAD' }, policy: '../policy.json', out: '../mirror', extra: true }));
  assert.throws(() => readView(f.view));
  assert.throws(() => parseArgs(['plan', '--view', f.view, '--out', 'other']));
  assert.throws(() => parseArgs(['status', '--out', 'other']));
  assert.throws(() => parseArgs(['publish', '--view', f.view, '--repo', 'other']));
});

test('symlink View files are rejected', t => {
  const f = fixture(t); const alias = join(f.base, 'alias.json');
  try { fs.symlinkSync(f.view, alias, 'file'); } catch { t.skip('symlink creation unavailable'); return; }
  assert.throws(() => readView(alias));
});

test('view HEAD resolution stays local with an unreachable remote', t => {
  const f = fixture(t); git(f.repo, ['remote', 'add', 'origin', 'https://127.0.0.1:1/unreachable.git']);
  assert.equal(resolveView(readView(f.view)).source.commit, f.commit);
});
