import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jsonBytes } from '../src/common.mjs';
import { readView, resolveView } from '../src/view.mjs';
import { run } from '../src/mirror.mjs';
import { publish, setPublishNetworkSeam } from '../src/publish.mjs';
import { setScannerProcessOverride } from '../src/secrets.mjs';

function git(repo, args) { return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim(); }
function fixture(t) {
  const base = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), 'ghostbound-publish-'))); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const restoreScanner = setScannerProcessOverride((args) => args[0] === 'version' ? { status: 0, stdout: Buffer.from('8.30.1'), stderr: Buffer.alloc(0) } : { status: 0, stdout: Buffer.from('[]'), stderr: Buffer.alloc(0) }); t.after(restoreScanner);
  const source = join(base, 'source'); fs.mkdirSync(source); git(source, ['init']); git(source, ['config', 'user.name', 'Publish Test']); git(source, ['config', 'user.email', 'publish@example.invalid']);
  fs.writeFileSync(join(source, 'README.md'), 'publish\n'); git(source, ['add', 'README.md']); git(source, ['commit', '-m', 'publish']);
  const policy = join(base, 'policy.json'); fs.writeFileSync(policy, jsonBytes({ schema: 'ghostbound.policy/v1', include: [{ path: 'README.md' }] }));
  const target = join(base, 'target'); const remote = join(base, 'remote.git'); fs.mkdirSync(target); git(target, ['init', '-b', 'main']); git(target, ['config', 'user.name', 'Publish Target']); git(target, ['config', 'user.email', 'target@example.invalid']); execFileSync('git', ['init', '--bare', remote], { stdio: 'ignore', windowsHide: true }); git(target, ['remote', 'add', 'origin', remote]);
  const viewFile = join(base, 'view.json'); fs.writeFileSync(viewFile, jsonBytes({ schema: 'ghostbound.view/v1', name: 'publish', source: { repo: source, ref: 'HEAD' }, policy, out: join(base, 'mirror'), publish: { repo: target, remote: 'origin', url: remote, branch: 'main' } }));
  return { base, source, policy, target, remote, viewFile };
}

test('publish creates and then reuses an exact verified tree', t => {
  const f = fixture(t); const indexBefore = fs.existsSync(join(f.target, '.git', 'index')) ? fs.readFileSync(join(f.target, '.git', 'index')) : null; const treeBefore = fs.readdirSync(f.target).sort(); let view = resolveView(readView(f.viewFile)); run({ repo: view.source.repo, commit: view.source.commit, policy: view.policy, out: view.out, materialize: true });
  const first = publish(view); assert.equal(first.published, true); assert.equal(git(f.remote, ['show-ref', 'refs/heads/main']).split(' ')[0], first.commit);
  assert.equal(git(f.target, ['show-ref', 'refs/ghostbound/views/publish']).split(' ')[0], first.commit);
  const second = publish(view); assert.equal(second.published, false); assert.equal(second.commit, first.commit);
  assert.equal(git(f.target, ['status', '--porcelain']), ''); assert.deepEqual(fs.readdirSync(f.target).sort(), treeBefore); assert.equal(fs.existsSync(join(f.target, '.git', 'index')) ? fs.readFileSync(join(f.target, '.git', 'index')).toString('hex') : null, indexBefore?.toString('hex') ?? null);
});

test('failed mirror or source verification performs no network write', t => {
  const f = fixture(t); const view = resolveView(readView(f.viewFile)); let calls = 0; const restoreNetwork = setPublishNetworkSeam(() => { calls++; throw new Error('network must not run'); }); t.after(restoreNetwork);
  assert.throws(() => publish(view)); assert.equal(calls, 0);
  run({ repo: view.source.repo, commit: view.source.commit, policy: view.policy, out: view.out, materialize: true });
  fs.writeFileSync(join(f.source, 'unselected.txt'), 'new source\n'); git(f.source, ['add', '.']); git(f.source, ['commit', '-m', 'source advanced']);
  const stale = resolveView(readView(f.viewFile)); assert.throws(() => publish(stale)); assert.equal(calls, 0);
});

test('publish refuses an existing foreign remote branch without local state', t => {
  const f = fixture(t); const foreign = join(f.base, 'foreign'); fs.mkdirSync(foreign); git(foreign, ['init']); git(foreign, ['config', 'user.name', 'Foreign']); git(foreign, ['config', 'user.email', 'foreign@example.invalid']); fs.writeFileSync(join(foreign, 'foreign.txt'), 'foreign'); git(foreign, ['add', '.']); git(foreign, ['commit', '-m', 'foreign']); git(foreign, ['remote', 'add', 'origin', f.remote]); git(foreign, ['push', 'origin', 'HEAD:refs/heads/main']);
  const view = resolveView(readView(f.viewFile)); run({ repo: view.source.repo, commit: view.source.commit, policy: view.policy, out: view.out, materialize: true });
  assert.throws(() => publish(view), /cannot be adopted|remote/);
});
