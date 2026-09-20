import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jsonBytes } from '../src/common.mjs';
import { readView, resolveView } from '../src/view.mjs';
import { status } from '../src/status.mjs';
import { run } from '../src/mirror.mjs';
import { setScannerProcessOverride } from '../src/secrets.mjs';

function git(repo, args) { return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim(); }
function fixture(t) {
  const base = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), 'ghostbound-status-'))); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const repo = join(base, 'source'); fs.mkdirSync(repo); git(repo, ['init']); git(repo, ['config', 'user.name', 'Status Test']); git(repo, ['config', 'user.email', 'status@example.invalid']);
  fs.writeFileSync(join(repo, 'README.md'), 'status\n'); fs.writeFileSync(join(repo, 'private.txt'), 'private\n'); git(repo, ['add', '.']); git(repo, ['commit', '-m', 'status']);
  const policy = join(base, 'policy.json'); fs.writeFileSync(policy, jsonBytes({ schema: 'ghostbound.policy/v1', include: [{ path: 'README.md' }] }));
  const viewFile = join(base, 'view.json'); fs.writeFileSync(viewFile, jsonBytes({ schema: 'ghostbound.view/v1', name: 'status', source: { repo, ref: 'HEAD' }, policy, out: join(base, 'mirror') }));
  const restore = setScannerProcessOverride((args) => args[0] === 'version' ? { status: 0, stdout: Buffer.from('8.30.1'), stderr: Buffer.alloc(0) } : { status: 0, stdout: Buffer.from('[]'), stderr: Buffer.alloc(0) }); t.after(restore);
  return { base, repo, policy, viewFile };
}

test('absent and empty output are UNVERIFIABLE', t => {
  const f = fixture(t); const view = resolveView(readView(f.viewFile));
  const absent = status(view); assert.equal(absent.status, 'UNVERIFIABLE');
  fs.mkdirSync(view.out); assert.equal(status(view).status, 'UNVERIFIABLE');
});

test('nonempty invalid output is INVALID without becoming UNVERIFIABLE', t => {
  const f = fixture(t); const view = resolveView(readView(f.viewFile)); fs.mkdirSync(view.out); fs.writeFileSync(join(view.out, 'foreign.txt'), 'foreign');
  assert.equal(status(view).status, 'INVALID');
});

test('status does not call a remote when source has an unreachable remote', t => {
  const f = fixture(t); git(f.repo, ['remote', 'add', 'origin', 'https://127.0.0.1:1/unreachable.git']); const view = resolveView(readView(f.viewFile));
  assert.equal(status(view).status, 'UNVERIFIABLE');
});

test('valid mirror is CURRENT, then source-only changes are STALE with empty disclosure delta', t => {
  const f = fixture(t); let view = resolveView(readView(f.viewFile));
  run({ repo: view.source.repo, commit: view.source.commit, policy: view.policy, out: view.out, materialize: true });
  assert.equal(status(view).status, 'CURRENT');
  fs.writeFileSync(join(f.repo, 'private.txt'), 'changed but not selected\n'); git(f.repo, ['add', 'private.txt']); git(f.repo, ['commit', '-m', 'unselected change']);
  view = resolveView(readView(f.viewFile)); const result = status(view);
  assert.equal(result.status, 'STALE'); assert.deepEqual(result.disclosure, { newlyExposed: [], changedExposed: [], noLongerExposed: [] });
  assert.ok(result.changes.update.includes('.ghostbound/manifest.json'));
});

test('selected content changes are changedExposed', t => {
  const f = fixture(t); let view = resolveView(readView(f.viewFile));
  run({ repo: view.source.repo, commit: view.source.commit, policy: view.policy, out: view.out, materialize: true });
  fs.writeFileSync(join(f.repo, 'README.md'), 'selected changed\n'); git(f.repo, ['add', 'README.md']); git(f.repo, ['commit', '-m', 'selected change']);
  view = resolveView(readView(f.viewFile)); const result = status(view);
  assert.equal(result.status, 'STALE'); assert.deepEqual(result.disclosure, { newlyExposed: [], changedExposed: ['README.md'], noLongerExposed: [] });
});
