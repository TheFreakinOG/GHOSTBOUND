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
function config(repo, key, value) { git(repo, ['config', key, value]); }
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

for (const rewrite of ['insteadOf', 'pushInsteadOf']) test(`publish rejects effective ${rewrite} rewrite`, t => {
  const f = fixture(t); const alternate = join(f.base, `rewritten-${rewrite}.git`); execFileSync('git', ['init', '--bare', alternate], { stdio: 'ignore', windowsHide: true });
  config(f.target, `url.${alternate}.${rewrite}`, f.remote);
  const view = resolveView(readView(f.viewFile)); run({ repo: view.source.repo, commit: view.source.commit, policy: view.policy, out: view.out, materialize: true }); let calls = 0;
  const restore = setPublishNetworkSeam(() => { calls++; throw new Error('network must not run'); }); t.after(restore);
  assert.throws(() => publish(view), /publish remote mismatch/); assert.equal(calls, 0);
});

test('publish rejects multiple effective URLs before network', t => {
  const f = fixture(t); config(f.target, 'remote.origin.pushurl', join(f.base, 'unexpected-push.git'));
  const view = resolveView(readView(f.viewFile)); run({ repo: view.source.repo, commit: view.source.commit, policy: view.policy, out: view.out, materialize: true }); let calls = 0;
  const restore = setPublishNetworkSeam(() => { calls++; throw new Error('network must not run'); }); t.after(restore);
  assert.throws(() => publish(view), /publish remote mismatch/); assert.equal(calls, 0);
});

for (const key of ['remote.origin.url', 'remote.origin.pushurl']) test(`publish rejects multiple raw ${key} values`, t => {
  const f = fixture(t); config(f.target, key, join(f.base, `second-${key.replaceAll('.', '-')}.git`));
  const view = resolveView(readView(f.viewFile)); run({ repo: view.source.repo, commit: view.source.commit, policy: view.policy, out: view.out, materialize: true }); let calls = 0;
  const restore = setPublishNetworkSeam(() => { calls++; throw new Error('network must not run'); }); t.after(restore);
  assert.throws(() => publish(view), /publish remote mismatch/); assert.equal(calls, 0);
});

for (const mutate of [
  view => { view.publish.url = join(view.source.repo, 'wrong-remote.git'); },
  view => { view.publish.branch = 'other'; },
  (view, f) => { fs.writeFileSync(join(f.target, 'tracked.txt'), 'dirty\n'); },
  (view, f) => { fs.writeFileSync(join(f.target, 'untracked.txt'), 'untracked\n'); },
  (view, f) => { fs.writeFileSync(join(f.target, 'staged.txt'), 'staged\n'); git(f.target, ['add', 'staged.txt']); },
]) test('target precondition blocks before network', t => {
  const f = fixture(t); const view = resolveView(readView(f.viewFile)); mutate(view, f); let calls = 0;
  const restore = setPublishNetworkSeam(() => { calls++; throw new Error('network must not run'); }); t.after(restore);
  assert.throws(() => publish(view)); assert.equal(calls, 0);
});

test('publication tree contains only mirror ownership and preserves target files', t => {
  const f = fixture(t); const view = resolveView(readView(f.viewFile));
  run({ repo: view.source.repo, commit: view.source.commit, policy: view.policy, out: view.out, materialize: true });
  const indexPath = join(f.target, '.git', 'index'); const before = fs.existsSync(indexPath) ? fs.readFileSync(indexPath).toString('hex') : null; const result = publish(view);
  const files = git(f.remote, ['ls-tree', '-r', '--name-only', result.commit]).split(/\r?\n/).filter(Boolean).sort();
  assert.deepEqual(files, ['.ghostbound/manifest.json', '.ghostbound/policy.json', 'README.md']);
  assert.equal(fs.existsSync(indexPath) ? fs.readFileSync(indexPath).toString('hex') : null, before);
  assert.equal(fs.existsSync(join(f.target, 'README.md')), false);
});

test('paths with spaces and executable mode are published from mirror bytes', t => {
  const f = fixture(t); const sourcePath = join(f.source, 'script with space.sh'); fs.writeFileSync(sourcePath, '#!/bin/sh\necho safe\n'); git(f.source, ['add', '.']); git(f.source, ['update-index', '--chmod=+x', '--', 'script with space.sh']); git(f.source, ['commit', '-m', 'space and mode']);
  fs.writeFileSync(f.policy, jsonBytes({ schema: 'ghostbound.policy/v1', include: [{ path: 'script with space.sh' }] }));
  const view = resolveView(readView(f.viewFile)); run({ repo: view.source.repo, commit: view.source.commit, policy: view.policy, out: view.out, materialize: true }); const result = publish(view);
  assert.equal(git(f.remote, ['ls-tree', result.commit, '--', 'script with space.sh']).split(/\s+/)[0], '100755');
  assert.equal(git(f.remote, ['show', `${result.commit}:script with space.sh`]), '#!/bin/sh\necho safe');
});

for (const tamper of ['content', 'extra', 'policy', 'provenance']) test(`publish rejects ${tamper} mirror state before network`, t => {
  const f = fixture(t); let view = resolveView(readView(f.viewFile)); run({ repo: view.source.repo, commit: view.source.commit, policy: view.policy, out: view.out, materialize: true });
  const out = join(f.base, 'mirror');
  if (tamper === 'content') fs.writeFileSync(join(out, 'README.md'), 'tampered\n');
  if (tamper === 'extra') fs.writeFileSync(join(out, 'extra.txt'), 'unexpected\n');
  if (tamper === 'policy') { fs.appendFileSync(f.policy, ' '); view = resolveView(readView(f.viewFile)); }
  if (tamper === 'provenance') { const manifest = JSON.parse(fs.readFileSync(join(out, '.ghostbound', 'manifest.json'))); manifest.source.commit = '1'.repeat(40); fs.writeFileSync(join(out, '.ghostbound', 'manifest.json'), jsonBytes(manifest)); }
  let calls = 0; const restore = setPublishNetworkSeam(() => { calls++; throw new Error('network must not run'); }); t.after(restore);
  assert.throws(() => publish(view)); assert.equal(calls, 0);
});

test('source, mirror and target overlap are rejected', t => {
  const f = fixture(t); const view = resolveView(readView(f.viewFile));
  view.publish.repo = f.source; assert.throws(() => publish(view));
  view.publish.repo = f.out; assert.throws(() => publish(view));
});

test('remote drift between preflight and push blocks and leaves state absent', t => {
  const f = fixture(t); const view = resolveView(readView(f.viewFile));
  run({ repo: view.source.repo, commit: view.source.commit, policy: view.policy, out: view.out, materialize: true });
  let reads = 0; const foreign = 'a'.repeat(40);
  const restore = setPublishNetworkSeam((repo, args) => {
    if (args[0] === 'ls-remote') { reads++; return Buffer.from(reads === 1 ? '' : `${foreign}\trefs/heads/main\n`); }
    throw new Error('push must not run after race');
  }); t.after(restore);
  assert.throws(() => publish(view), /remote drift/); assert.equal(reads, 2); assert.throws(() => git(f.target, ['show-ref', '--verify', 'refs/ghostbound/views/publish']));
});

test('push rejection and post-push mismatch leave state ref unchanged', t => {
  for (const mode of ['reject', 'mismatch']) {
    const f = fixture(t); const view = resolveView(readView(f.viewFile));
    run({ repo: view.source.repo, commit: view.source.commit, policy: view.policy, out: view.out, materialize: true });
    let reads = 0; const wrong = 'b'.repeat(40);
    const restore = setPublishNetworkSeam((repo, args) => {
      if (args[0] === 'ls-remote') { reads++; return Buffer.from(reads === 1 || reads === 2 ? '' : `${mode === 'mismatch' ? wrong : ''}${mode === 'mismatch' ? '\trefs/heads/main\n' : ''}`); }
      if (mode === 'reject') throw new Error('synthetic push rejection');
      return Buffer.alloc(0);
    });
    try { assert.throws(() => publish(view), /push failed|confirmation mismatch/); assert.throws(() => git(f.target, ['show-ref', '--verify', 'refs/ghostbound/views/publish'])); }
    finally { restore(); }
  }
});

test('idempotent publish performs no push', t => {
  const f = fixture(t); const view = resolveView(readView(f.viewFile));
  run({ repo: view.source.repo, commit: view.source.commit, policy: view.policy, out: view.out, materialize: true }); const first = publish(view);
  let pushes = 0; const restore = setPublishNetworkSeam((repo, args) => { if (args[0] === 'push') pushes++; return git(f.target, args); }); t.after(restore);
  const second = publish(view); assert.equal(second.published, false); assert.equal(second.commit, first.commit); assert.equal(pushes, 0);
});

test('publisher source contains no force push or target git add', () => {
  const text = fs.readFileSync(new URL('../src/publish.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(text, /--force(?:-with-lease)?|\+refspec/); assert.doesNotMatch(text, /\['add'/);
  assert.match(text, /\['push', '--no-verify'/);
});

test('network Git operations are isolated to publish layer', () => {
  for (const file of ['src/cli.mjs', 'src/common.mjs', 'src/delta.mjs', 'src/git.mjs', 'src/manifest.mjs', 'src/mirror.mjs', 'src/policy.mjs', 'src/paths.mjs', 'src/secrets.mjs', 'src/status.mjs', 'src/view.mjs']) {
    const text = fs.readFileSync(join(process.cwd(), file), 'utf8');
    assert.doesNotMatch(text, /['"](?:ls-remote|push|fetch|pull|clone)['"]/);
  }
});
