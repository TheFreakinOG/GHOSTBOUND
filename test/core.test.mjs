import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { strictJSON, jsonBytes, sha256, LIMITS } from '../src/common.mjs';
import { safePath, checkCollisions } from '../src/paths.mjs';
import { parsePolicy, select } from '../src/policy.mjs';
import { snapshot, parseTree, gitEnv } from '../src/git.mjs';
import { run, verify } from '../src/mirror.mjs';
import { aggregate, MANIFEST, POLICY } from '../src/manifest.mjs';
import { parseArgs } from '../src/cli.mjs';
import { scannerProcess, assertScanResult } from '../src/secrets.mjs';

const project = fileURLToPath(new URL('..', import.meta.url));
const scanner = spawnSync('gitleaks', ['version'], { windowsHide: true });
const hasScanner = !scanner.error && scanner.status === 0;
if (process.env.GHOSTBOUND_REQUIRE_GITLEAKS === '1') assert.ok(hasScanner, 'real Gitleaks required');
function git(repo, args, input) {
  return execFileSync('git', ['-C', repo, ...args], { input, env: gitEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }).toString().trim();
}
function file(root, name, bytes) { fs.mkdirSync(join(root, name, '..'), { recursive: true }); fs.writeFileSync(join(root, name), bytes); }
function fixture(t, format = 'sha1') {
  const base = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), 'ghostbound-test-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const repo = join(base, 'source'); fs.mkdirSync(repo); git(repo, ['init', '--object-format=' + format]);
  git(repo, ['config', 'user.name', 'Synthetic Test']); git(repo, ['config', 'user.email', 'test@example.invalid']);
  git(repo, ['config', 'core.autocrlf', 'false']);
  file(repo, 'README.md', '# Synthetic fixture\n'); file(repo, 'src/a.mjs', 'export const a = 1;\n'); file(repo, 'src/b.mjs', 'export const b = 2;\n');
  git(repo, ['add', '--', 'README.md', 'src/a.mjs', 'src/b.mjs']); git(repo, ['commit', '-m', 'synthetic fixture']);
  const policy = join(base, 'policy.json'); fs.writeFileSync(policy, jsonBytes({ schema: 'ghostbound.policy/v1', include: [{ path: 'README.md' }, { tree: 'src' }] }));
  return { base, repo, policy, commit: git(repo, ['rev-parse', 'HEAD']), out: join(base, 'mirror') };
}
function input(f) { return parsePolicy(fs.readFileSync(f.policy)); }
function snap(f) { const p = input(f); return snapshot(f.repo, f.commit, p.policy, p.limits); }
function setPolicy(f, include, limits) { fs.writeFileSync(f.policy, jsonBytes({ schema: 'ghostbound.policy/v1', include, ...(limits ? { limits } : {}) })); }
function commitFile(f, name, bytes) { file(f.repo, name, bytes); git(f.repo, ['add', '--', name]); git(f.repo, ['commit', '-m', 'synthetic change']); f.commit = git(f.repo, ['rev-parse', 'HEAD']); }
function inject(f, path, mode, bytes = 'synthetic') {
  const oid = mode === '160000' ? f.commit : git(f.repo, ['hash-object', '-w', '--stdin'], Buffer.from(bytes));
  git(f.repo, ['update-index', '--add', '--cacheinfo', `${mode},${oid},${path}`]);
  const tree = git(f.repo, ['write-tree']); f.commit = git(f.repo, ['commit-tree', tree, '-p', f.commit, '-m', 'synthetic index']);
}
function materialize(f) { return run({ ...f, materialize: true }); }
function integration(name, fn) { test(name, { skip: !hasScanner && 'install Gitleaks for real integration tests' }, fn); }
function logical(out) {
  const result = {}; function walk(rel) { for (const name of fs.readdirSync(join(out, rel)).sort()) { const dest = rel ? rel + '/' + name : name; if (fs.statSync(join(out, dest)).isDirectory()) walk(dest); else result[dest] = fs.readFileSync(join(out, dest)).toString('hex'); } } walk(''); return result;
}

for (const path of ['..', '.', '../x', 'a/../x', 'a/./x', '/etc/passwd', 'C:/x', '//server/share', '\\\\server\\share', 'a\\b', '', 'a//b', 'a/', 'CON', 'con.txt', 'PRN', 'AUX', 'NUL', 'COM1', 'LPT9.log', 'COM¹.txt', 'x.', 'x ', 'x:y', 'x?y', 'x*y', 'x<y', 'x>y', 'x|y', 'x"y', 'a\0b', 'a\nb', 'a\tb', '.ghostbound/x', '.GHOSTBOUND', 'x/.ghostbound/y', '.git/config', 'e\u0301.txt', 'x\u202ey']) {
  test('reject unsafe path ' + JSON.stringify(path), () => assert.throws(() => safePath(path)));
}
for (const paths of [['Foo.js', 'foo.js'], ['a', 'a/b.js'], ['a/b.js', 'a'], ['A/x', 'a/y'], ['é.txt', 'e\u0301.txt'], ['same', 'same'], ['ß', 'SS']]) {
  test('reject collisions ' + JSON.stringify(paths), () => assert.throws(() => checkCollisions(paths)));
}
test('portable UTF-8 paths accepted', () => checkCollisions(['src/é.mjs', 'docs/hello world.md', 'emoji/😀.txt']));
for (const text of ['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"x":{"a":1,"a":2}}', '{"x":}', '{"x":01}', '{"x":NaN}', '{"x":1,}', '[1,]', '{} trailing', '"\\ud800"']) {
  test('strict JSON rejects ' + text, () => assert.throws(() => strictJSON(Buffer.from(text))));
}
test('strict JSON handles escaped strings, Unicode and nesting', () => assert.deepEqual(strictJSON(Buffer.from('{"x":[true,null,-1.2e3,"a\\\"b","😀"]}')), { x: [true, null, -1200, 'a"b', '😀'] }));
for (const policy of [null, {}, { schema: 'other', include: [] }, { schema: 'ghostbound.policy/v1', include: [] }, { schema: 'ghostbound.policy/v1', include: [{ path: 'x', extra: true }] }, { schema: 'ghostbound.policy/v1', include: [{ path: 'x', tree: 'x' }] }, { schema: 'ghostbound.policy/v1', include: [{ path: 1 }] }, { schema: 'ghostbound.policy/v1', include: [{ path: 'x' }], extra: true }, { schema: 'ghostbound.policy/v1', include: [{ path: 'x' }], limits: { maxFiles: 10001 } }]) {
  test('invalid policy ' + JSON.stringify(policy), () => assert.throws(() => parsePolicy(jsonBytes(policy))));
}
test('exact, tree, rename and deterministic mapping', t => {
  const f = fixture(t); setPolicy(f, [{ path: 'README.md', to: 'ABOUT.md' }, { tree: 'src', to: 'lib' }]);
  assert.deepEqual(snap(f).entries.map(e => e.destination), ['ABOUT.md', 'lib/a.mjs', 'lib/b.mjs']);
});
for (const include of [[{ path: 'missing' }], [{ tree: 'missing' }], [{ tree: 'README.md' }], [{ tree: 'src' }, { path: 'src/a.mjs' }], [{ path: 'README.md', to: 'x' }, { path: 'src/a.mjs', to: 'x' }]]) {
  test('policy mismatch blocks ' + JSON.stringify(include), t => { const f = fixture(t); setPolicy(f, include); assert.throws(() => snap(f)); });
}
for (const ref of ['HEAD', 'main', 'v1.0', 'HEAD~1', '--upload-pack=evil', 'abc123', 'a'.repeat(40) + '^{tree}']) {
  test('reject non-commit input ' + ref, t => { const f = fixture(t); f.commit = ref; assert.throws(() => snap(f), /full lowercase commit/); });
}
for (const format of ['sha1', 'sha256']) test('full ' + format + ' commit accepted', t => { const f = fixture(t, format); assert.equal(snap(f).source.objectFormat, format); });
test('tree OID is not accepted as commit', t => { const f = fixture(t); f.commit = git(f.repo, ['rev-parse', 'HEAD^{tree}']); assert.throws(() => snap(f), /not a commit/); });
test('dirty, deleted and untracked working files never become source', t => {
  const f = fixture(t); const before = snap(f); fs.writeFileSync(join(f.repo, 'src/a.mjs'), 'dirty'); fs.unlinkSync(join(f.repo, 'README.md')); file(f.repo, 'src/untracked', 'untracked'); assert.deepEqual(snap(f), before);
});
test('ambient Git overrides and replace objects cannot redirect snapshot', t => {
  const f = fixture(t); const original = snap(f); const before = process.env.GIT_DIR;
  process.env.GIT_DIR = join(f.base, 'wrong'); try { assert.deepEqual(snap(f), original); } finally { if (before === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = before; }
  const originalCommit = f.commit; commitFile(f, 'README.md', 'replacement'); git(f.repo, ['replace', originalCommit, f.commit]); f.commit = originalCommit; assert.deepEqual(snap(f), original);
});
for (const mode of ['120000', '160000']) for (const tree of [false, true]) test(`selected mode ${mode} with ${tree ? 'tree' : 'exact'} blocks`, t => {
  const f = fixture(t); inject(f, 'src/special', mode); setPolicy(f, [tree ? { tree: 'src' } : { path: 'src/special' }]); assert.throws(() => snap(f), /not a regular blob/);
});
test('unsupported mode blocks selection', () => assert.throws(() => select([{ path: Buffer.from('x'), type: 'blob', mode: '100600', oid: 'a'.repeat(40) }], { include: [{ path: 'x' }] }), /regular blob/));
test('tree parser is NUL safe and selected invalid UTF-8 blocks', () => {
  const b = Buffer.concat([Buffer.from('100644 blob ' + 'a'.repeat(40) + '\tsrc/'), Buffer.from([255]), Buffer.from('\0')]);
  const entries = parseTree(b, 'sha1'); assert.equal(entries.length, 1); assert.throws(() => select(entries, { include: [{ tree: 'src' }] }), /UTF-8/);
  assert.throws(() => parseTree(b.subarray(0, -1), 'sha1'), /unterminated/);
});
for (const name of ['src/a\nb', 'src/e\u0301.txt']) test('selected raw Git path blocks ' + JSON.stringify(name), t => {
  const f = fixture(t); const oid = git(f.repo, ['hash-object', '-w', '--stdin'], Buffer.from('synthetic'));
  const subtree = git(f.repo, ['hash-object', '-t', 'tree', '-w', '--stdin'], Buffer.concat([Buffer.from('100644 ' + name.slice(4) + '\0'), Buffer.from(oid, 'hex')]));
  const tree = git(f.repo, ['hash-object', '-t', 'tree', '-w', '--stdin'], Buffer.concat([Buffer.from('40000 src\0'), Buffer.from(subtree, 'hex')]));
  f.commit = git(f.repo, ['commit-tree', tree, '-m', 'synthetic raw tree']); setPolicy(f, [{ tree: 'src' }]); assert.throws(() => snap(f), /noncanonical/);
});
for (const bytes of [Buffer.from([255]), Buffer.from('hello\0world'), Buffer.from([1, 2, 3]), Buffer.from('version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 1\n')]) {
  test('unsupported content blocks ' + bytes.toString('hex').slice(0, 30), t => { const f = fixture(t); commitFile(f, 'src/a.mjs', bytes); assert.throws(() => snap(f), /UTF-8|binary|LFS/); });
}
for (const limits of [{ maxFiles: 1 }, { maxFileBytes: 1 }, { maxTotalBytes: 1 }]) test('resource limit ' + JSON.stringify(limits), t => { const f = fixture(t); setPolicy(f, [{ tree: 'src' }], limits); assert.throws(() => snap(f), /limit/); });
test('missing scanner blocks', () => assert.throws(() => assertScanResult(scannerProcess([], project, 'ghostbound-nonexistent-scanner')), /blocked/));
for (const script of ['console.log("[]");process.exit(2)', 'console.log("[]");process.exit(23)', 'console.log("[{\\"Secret\\":\\"never-echo-me\\"}]")', 'console.log("null")', 'console.log("bad report")']) {
  test('scanner failure cannot expose content ' + script.slice(0, 24), () => {
    assert.throws(() => assertScanResult(scannerProcess([], project, process.execPath, ['-e', script])), e => !e.message.includes('never-echo-me'));
  });
}
test('clean scanner report accepted', () => assertScanResult(scannerProcess([], project, process.execPath, ['-e', 'console.log("[]")'])));
test('CLI rejects disable, force, injection and partial source verification', () => {
  for (const argv of [['plan', '--no-secret-scan'], ['materialize', '--force'], ['verify', '--out', 'x', '--repo', 'y'], ['plan', '--commit', '--upload-pack=x'], ['verify', '--out', 'x', '--out', 'y']]) assert.throws(() => parseArgs(argv));
});
test('Git layer has no shell or network command invocation', () => {
  const text = fs.readFileSync(join(project, 'src/git.mjs'), 'utf8'); assert.doesNotMatch(text, /shell\s*:|execSync\(|['"](?:clone|fetch|pull|push|ls-remote)['"]/); assert.match(text, /execFileSync/); assert.match(text, /GIT_NO_LAZY_FETCH/);
});

integration('absent output, real scanner, integrity and source provenance', t => {
  const f = fixture(t); assert.equal(materialize(f).applied, true); assert.equal(verify({ out: f.out }).verified, true); assert.equal(verify(f).sourceProvenance, true);
});
integration('empty output initializes', t => { const f = fixture(t); fs.mkdirSync(f.out); materialize(f); assert.equal(verify(f).verified, true); });
integration('plan leaves absent and existing output untouched', t => {
  const f = fixture(t); assert.equal(run(f).applied, false); assert.equal(fs.existsSync(f.out), false); materialize(f); const before = logical(f.out); commitFile(f, 'src/a.mjs', 'updated'); assert.ok(run(f).changes.update.includes('src/a.mjs')); assert.deepEqual(logical(f.out), before);
});
integration('valid update removes stale file and preserves new bytes', t => {
  const f = fixture(t); materialize(f); setPolicy(f, [{ path: 'README.md' }]); const result = materialize(f); assert.deepEqual(result.changes.delete, ['src/a.mjs', 'src/b.mjs']); assert.equal(fs.existsSync(join(f.out, 'src')), false); verify(f);
});
integration('deterministic independent materializations contain no absolute paths', t => {
  const f = fixture(t); materialize(f); const first = logical(f.out); const second = { ...f, out: join(f.base, 'other') }; materialize(second); assert.deepEqual(logical(second.out), first);
  const manifest = fs.readFileSync(join(f.out, MANIFEST), 'utf8'); assert.ok(!manifest.includes(f.base) && !manifest.includes(f.base.replaceAll('\\', '/')));
  assert.ok(!manifest.includes('timestamp')); assert.deepEqual(run(f).changes, { create: [], update: [], delete: [] });
});
test('nonempty foreign output blocks without mutation', t => { const f = fixture(t); file(f.out, 'foreign.txt', 'keep'); assert.throws(() => materialize(f)); assert.deepEqual(fs.readdirSync(f.out), ['foreign.txt']); });
for (const tamper of ['content', 'missing', 'extra', 'empty-directory', 'policy', 'manifest', 'aggregate', 'blob', 'metadata-extra']) integration('tampered mirror blocks verify and update: ' + tamper, t => {
  const f = fixture(t); materialize(f);
  if (tamper === 'content') file(f.out, 'src/a.mjs', 'tamper');
  if (tamper === 'missing') fs.unlinkSync(join(f.out, 'src/a.mjs'));
  if (tamper === 'extra') file(f.out, 'extra', 'retain');
  if (tamper === 'empty-directory') fs.mkdirSync(join(f.out, 'extra-dir'));
  if (tamper === 'policy') fs.appendFileSync(join(f.out, POLICY), ' ');
  if (tamper === 'metadata-extra') file(f.out, '.ghostbound/extra', 'retain');
  if (['manifest', 'aggregate', 'blob'].includes(tamper)) {
    const m = JSON.parse(fs.readFileSync(join(f.out, MANIFEST)));
    if (tamper === 'manifest') m.extra = true;
    if (tamper === 'aggregate') m.mirror.sha256 = '0'.repeat(64);
    if (tamper === 'blob') m.files[0].gitBlobOid = '0'.repeat(40);
    fs.writeFileSync(join(f.out, MANIFEST), jsonBytes(m));
  }
  const before = logical(f.out); assert.throws(() => verify({ out: f.out })); assert.throws(() => materialize(f)); assert.deepEqual(logical(f.out), before);
});
test('output/source nesting rejected in both directions', t => {
  const f = fixture(t); assert.throws(() => run({ ...f, out: join(f.repo, 'mirror') }), /disjoint/); assert.throws(() => run({ ...f, out: f.base }), /disjoint/);
});
test('output junction or symlink rejected', t => {
  const f = fixture(t); const target = join(f.base, 'target'); fs.mkdirSync(target); fs.symlinkSync(target, f.out, process.platform === 'win32' ? 'junction' : 'dir'); assert.throws(() => run(f), /real directory/);
});
integration('injected nested junction blocks verify and update', t => {
  const f = fixture(t); materialize(f); const target = join(f.base, 'external'); fs.mkdirSync(target); fs.symlinkSync(target, join(f.out, 'escape'), process.platform === 'win32' ? 'junction' : 'dir'); assert.throws(() => verify(f), /link/); assert.throws(() => materialize(f), /link/); assert.ok(fs.lstatSync(join(f.out, 'escape')).isSymbolicLink());
});
integration('executable mode preserved', t => { const f = fixture(t); inject(f, 'src/a.mjs', '100755', 'echo synthetic\n'); materialize(f); const m = JSON.parse(fs.readFileSync(join(f.out, MANIFEST))); assert.equal(m.files.find(e => e.source === 'src/a.mjs').gitMode, '100755'); verify(f); });
integration('finding blocks even with source config, ignore and allow comments', t => {
  const f = fixture(t); materialize(f); const before = logical(f.out);
  const synthetic = ['ghp_', sha256('synthetic ghostbound test credential').slice(0, 36)].join('');
  commitFile(f, 'src/a.mjs', 'token = "' + synthetic + '" // gitleaks:allow\n');
  commitFile(f, '.gitleaks.toml', '[allowlist]\nregexes = [".*"]\n'); commitFile(f, '.gitleaksignore', '*\n');
  setPolicy(f, [{ tree: 'src' }, { path: '.gitleaks.toml' }, { path: '.gitleaksignore' }]);
  assert.throws(() => materialize(f), e => /scan blocked/.test(e.message) && !e.message.includes(synthetic)); assert.deepEqual(logical(f.out), before);
});
integration('staging write failure leaves old mirror untouched', t => {
  const f = fixture(t); materialize(f); const before = logical(f.out); const original = fs.writeFileSync;
  fs.writeFileSync = (...args) => { if (String(args[0]).includes('.ghostbound-stage-')) throw new Error('injected write failure'); return original(...args); }; syncBuiltinESMExports();
  try { assert.throws(() => materialize(f), /injected/); } finally { fs.writeFileSync = original; syncBuiltinESMExports(); }
  assert.deepEqual(logical(f.out), before);
});
integration('replacement rename failure restores old mirror', t => {
  const f = fixture(t); materialize(f); const before = logical(f.out); commitFile(f, 'src/a.mjs', 'new');
  const original = fs.renameSync; let calls = 0;
  fs.renameSync = (...args) => { if (++calls === 2) throw new Error('injected rename'); return original(...args); }; syncBuiltinESMExports();
  try { assert.throws(() => materialize(f), /previous output restored/); } finally { fs.renameSync = original; syncBuiltinESMExports(); }
  assert.equal(calls, 3); assert.deepEqual(logical(f.out), before); verify({ out: f.out });
});
integration('source verification rejects wrong commit and policy', t => {
  const f = fixture(t); materialize(f); commitFile(f, 'outside.txt', 'unselected'); assert.throws(() => verify(f), /commit or tree/);
  const m = JSON.parse(fs.readFileSync(join(f.out, MANIFEST))); f.commit = m.source.commit; fs.appendFileSync(f.policy, ' '); assert.throws(() => verify(f), /policy/);
});
integration('self-consistent provenance forgery requires source verification', t => {
  const f = fixture(t); materialize(f); const m = JSON.parse(fs.readFileSync(join(f.out, MANIFEST))); m.source.commit = '1'.repeat(40); fs.writeFileSync(join(f.out, MANIFEST), jsonBytes(m));
  assert.equal(verify({ out: f.out }).verified, true); assert.throws(() => verify(f), /commit or tree/);
});
test('aggregate encoding is unambiguous', () => assert.notEqual(aggregate([{ destination: 'ab', gitMode: '100644', sha256: 'c' }]), aggregate([{ destination: 'a', gitMode: '100644', sha256: 'bc' }])));

test('safe directory configuration is not bypassed', t => {
  const f = fixture(t); const before = process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER; process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = '1';
  try { assert.ok(!Object.hasOwn(gitEnv(), 'GIT_TEST_ASSUME_DIFFERENT_OWNER')); } finally { if (before === undefined) delete process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER; else process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = before; }
  const source = fs.readFileSync(join(project, 'src/git.mjs'), 'utf8'); assert.doesNotMatch(source, /safe\.directory=/);
});
test('deleted committed exact path blocks', t => {
  const f = fixture(t); git(f.repo, ['rm', '--', 'README.md']); git(f.repo, ['commit', '-m', 'synthetic deletion']); f.commit = git(f.repo, ['rev-parse', 'HEAD']); assert.throws(() => snap(f), /no matches/);
});
test('raw invalid UTF-8 source outside explicit selection is never read', t => {
  const f = fixture(t); commitFile(f, 'outside.dat', Buffer.from([255, 0])); assert.equal(snap(f).entries.length, 3);
});
integration('metadata absence blocks without repair', t => {
  const f = fixture(t); materialize(f); fs.unlinkSync(join(f.out, MANIFEST)); assert.throws(() => materialize(f)); assert.equal(fs.existsSync(join(f.out, MANIFEST)), false);
});
integration('hardlinked file blocks verification', t => {
  const f = fixture(t); materialize(f); fs.linkSync(join(f.out, 'README.md'), join(f.base, 'alias')); assert.throws(() => verify(f), /special file/);
});
test('junction in output ancestor blocks', t => {
  const f = fixture(t); const target = join(f.base, 'target'); const alias = join(f.base, 'alias'); fs.mkdirSync(target); fs.symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => run({ ...f, out: join(alias, 'mirror') }), /real directory/);
});
for (const scenario of ['missing', 'error', 'finding', 'malformed', 'signal']) integration('scanner ' + scenario + ' leaves existing mirror untouched and diagnostics private', t => {
  const f = fixture(t); materialize(f); const before = logical(f.out); const original = childProcess.spawnSync;
  childProcess.spawnSync = (exe, args, options) => {
    if (exe !== 'gitleaks') return original(exe, args, options);
    if (scenario === 'missing') return { error: new Error('DO-NOT-EXPOSE'), status: null };
    if (args[0] === 'version') return { status: 0, stdout: Buffer.from('8.30.1') };
    return { status: scenario === 'error' ? 2 : scenario === 'finding' ? 23 : 0, signal: scenario === 'signal' ? 'SIGTERM' : null,
      stdout: Buffer.from(scenario === 'malformed' ? 'DO-NOT-EXPOSE' : '[]'), stderr: Buffer.from('DO-NOT-EXPOSE') };
  }; syncBuiltinESMExports();
  try { assert.throws(() => materialize(f), e => !e.message.includes('DO-NOT-EXPOSE')); }
  finally { childProcess.spawnSync = original; syncBuiltinESMExports(); }
  assert.deepEqual(logical(f.out), before);
});
integration('final verification error restores old mirror', t => {
  const f = fixture(t); materialize(f); const before = logical(f.out); const original = fs.renameSync; let calls = 0;
  fs.renameSync = (...args) => {
    const result = original(...args);
    if (++calls === 2) fs.writeFileSync(join(f.out, 'README.md'), 'synthetic corrupt replacement');
    return result;
  }; syncBuiltinESMExports();
  try { assert.throws(() => materialize(f), /previous output restored/); }
  finally { fs.renameSync = original; syncBuiltinESMExports(); }
  assert.equal(calls, 4); assert.deepEqual(logical(f.out), before);
});
integration('rollback failure retains recoverable backup', t => {
  const f = fixture(t); materialize(f); const before = logical(f.out); const original = fs.renameSync; let calls = 0;
  fs.renameSync = (...args) => { if (++calls >= 2) throw new Error('synthetic blocked rename'); return original(...args); }; syncBuiltinESMExports();
  try { assert.throws(() => materialize(f), /rollback failed/); }
  finally { fs.renameSync = original; syncBuiltinESMExports(); }
  assert.equal(fs.existsSync(f.out), false); const work = fs.readdirSync(f.base).find(p => p.startsWith('.ghostbound-stage-'));
  assert.ok(work); const backup = join(f.base, work, 'previous'); assert.deepEqual(logical(backup), before); assert.equal(verify({ out: backup }).verified, true);
});
integration('source verification catches forged mapping and omitted tree member', t => {
  const f = fixture(t); materialize(f); const m = JSON.parse(fs.readFileSync(join(f.out, MANIFEST)));
  const removed = m.files.pop(); fs.unlinkSync(join(f.out, removed.destination)); m.mirror.fileCount--; m.mirror.totalBytes -= removed.bytes; m.mirror.sha256 = aggregate(m.files); fs.writeFileSync(join(f.out, MANIFEST), jsonBytes(m));
  assert.equal(verify({ out: f.out }).verified, true); assert.throws(() => verify(f), /source files/);
});
integration('policy bytes containing a detectable secret block before output exists', t => {
  const f = fixture(t); const name = 'ghp_' + sha256('another synthetic credential').slice(0, 36); commitFile(f, name, 'ordinary'); setPolicy(f, [{ path: name, to: 'safe.txt' }]);
  assert.throws(() => materialize(f), /scan blocked/); assert.equal(fs.existsSync(f.out), false);
});
integration('Gitleaks ambient configuration cannot disable scanning', t => {
  const f = fixture(t); commitFile(f, 'src/a.mjs', 'token="ghp_' + sha256('synthetic environment regression').slice(0, 36) + '"');
  const before = process.env.GITLEAKS_CONFIG_TOML; process.env.GITLEAKS_CONFIG_TOML = '[allowlist]\nregexes=[".*"]';
  try { assert.throws(() => materialize(f), /scan blocked/); }
  finally { if (before === undefined) delete process.env.GITLEAKS_CONFIG_TOML; else process.env.GITLEAKS_CONFIG_TOML = before; }
});
