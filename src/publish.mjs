import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { check, jsonBytes, sha256, strictJSON, utf8 } from './common.mjs';
import { confinedRoot, disjoint } from './paths.mjs';
import { gitEnv, parseTree, validOid } from './git.mjs';
import { verify } from './mirror.mjs';
import { validateManifest, verifyMirror } from './manifest.mjs';
import { diffMaps, filesystemMap } from './delta.mjs';

function localGit(repo, args, { input, env = {}, maxBuffer = 33554432 } = {}) {
  try {
    return execFileSync('git', ['--no-replace-objects', '-C', repo, ...args], {
      input, env: { ...gitEnv(), ...env }, timeout: 30000, maxBuffer, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
  } catch { throw new Error('publish blocked: Git operation failed'); }
}

function tryLocalGit(repo, args, options = {}) {
  try { return { ok: true, stdout: localGit(repo, args, options) }; }
  catch { return { ok: false }; }
}

function objectFormat(repo) {
  const format = localGit(repo, ['rev-parse', '--show-object-format'], { maxBuffer: 1024 }).toString().trim();
  check(['sha1', 'sha256'].includes(format), 'publish blocked: unsupported target object format');
  return format;
}

function commitAt(repo, ref, format) {
  const result = tryLocalGit(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { maxBuffer: 1024 });
  if (!result.ok) return null;
  const commit = result.stdout.toString().trim();
  check(validOid(commit, format), 'publish blocked: invalid local commit');
  return commit;
}

function configuredTarget(view) {
  check(view.publish, 'publish configuration required');
  const repo = confinedRoot(view.publish.repo);
  const bare = localGit(repo, ['rev-parse', '--is-bare-repository'], { maxBuffer: 1024 }).toString().trim() === 'true';
  const root = localGit(repo, ['rev-parse', bare ? '--absolute-git-dir' : '--show-toplevel'], { maxBuffer: 4096 }).toString().trim();
  const canonicalRoot = realpathSync.native(root);
  const canonicalRepo = realpathSync.native(repo);
  check(process.platform === 'win32' ? canonicalRoot.toLowerCase() === canonicalRepo.toLowerCase() : canonicalRoot === canonicalRepo, 'publish repo must be the Git root');
  const name = view.publish.remote;
  const urls = tryLocalGit(repo, ['config', '--get-all', `remote.${name}.url`], { maxBuffer: 4096 });
  const pushUrls = tryLocalGit(repo, ['config', '--get-all', `remote.${name}.pushurl`], { maxBuffer: 4096 });
  check(urls.ok && urls.stdout.toString().trim().length > 0, 'publish remote mismatch');
  const fetchUrls = urls.stdout.toString().split(/\r?\n/).filter(Boolean);
  const configuredPushUrls = pushUrls.ok ? pushUrls.stdout.toString().split(/\r?\n/).filter(Boolean) : [];
  check(fetchUrls.length === 1 && fetchUrls[0] === view.publish.url, 'publish remote mismatch');
  check((configuredPushUrls.length === 0 && fetchUrls[0] === view.publish.url) || (configuredPushUrls.length === 1 && configuredPushUrls[0] === view.publish.url), 'publish remote mismatch');
  const effectiveFetch = tryLocalGit(repo, ['remote', 'get-url', '--all', name], { maxBuffer: 4096 });
  const effectivePush = tryLocalGit(repo, ['remote', 'get-url', '--push', '--all', name], { maxBuffer: 4096 });
  const effectiveFetchUrls = effectiveFetch.ok ? effectiveFetch.stdout.toString().split(/\r?\n/).filter(Boolean) : [];
  const effectivePushUrls = effectivePush.ok ? effectivePush.stdout.toString().split(/\r?\n/).filter(Boolean) : [];
  check(effectiveFetchUrls.length === 1 && effectiveFetchUrls[0] === view.publish.url, 'publish remote mismatch');
  check(effectivePushUrls.length === 1 && effectivePushUrls[0] === view.publish.url, 'publish remote mismatch');
  return { repo, format: objectFormat(repo), bare };
}

function remoteGit(repo, args, options = {}) { return localGit(repo, args, options); }
let networkRunner = remoteGit;
export function setPublishNetworkSeam(runner) {
  const previous = networkRunner;
  networkRunner = runner;
  return () => { networkRunner = previous; };
}

function remoteTip(target, view) {
  let bytes;
  try { bytes = networkRunner(target.repo, ['ls-remote', '--refs', view.publish.remote, `refs/heads/${view.publish.branch}`], { maxBuffer: 4096 }); }
  catch { throw new Error('publish blocked: remote state unavailable'); }
  const text = bytes.toString().trim();
  if (!text) return null;
  const lines = text.split(/\r?\n/);
  check(lines.length === 1, 'publish blocked: ambiguous remote state');
  const match = /^([0-9a-f]{40}|[0-9a-f]{64})\trefs\/heads\/[^\r\n]+$/.exec(lines[0]);
  check(match, 'publish blocked: malformed remote state');
  check(validOid(match[1], target.format), 'publish blocked: remote object format mismatch');
  return match[1];
}

function readTree(target, tree) {
  const entries = parseTree(localGit(target.repo, ['ls-tree', '-r', '-z', '--full-tree', tree]), target.format);
  const result = new Map();
  for (const entry of entries) {
    check(entry.type === 'blob' && ['100644', '100755'].includes(entry.mode), 'publish blocked: previous tree contains unsupported entry');
    const path = utf8(entry.path);
    check(!result.has(path), 'publish blocked: duplicate previous tree path');
    const bytes = localGit(target.repo, ['cat-file', 'blob', entry.oid], { maxBuffer: 16777217 });
    result.set(path, { mode: entry.mode, oid: entry.oid, bytes, sha256: sha256(bytes) });
  }
  return result;
}

function expectedMirror(mirror) {
  const expected = new Map(mirror.manifest.files.map(record => [record.destination, { mode: record.gitMode, bytes: record.bytes, sha256: record.sha256 }]));
  expected.set('.ghostbound/manifest.json', { mode: '100644', bytes: mirror.manifestBytes.length, sha256: sha256(mirror.manifestBytes) });
  expected.set('.ghostbound/policy.json', { mode: '100644', bytes: mirror.policyBytes.length, sha256: sha256(mirror.policyBytes) });
  return expected;
}

function verifyTree(target, tree, mirror) {
  const actual = readTree(target, tree);
  const expected = expectedMirror(mirror);
  check(actual.size === expected.size && [...expected.keys()].every(path => actual.has(path)), 'publish blocked: publication tree ownership mismatch');
  for (const [path, item] of expected) {
    const found = actual.get(path);
    check(found.mode === item.mode && found.bytes.length === item.bytes && found.sha256 === item.sha256, 'publish blocked: publication tree bytes mismatch');
  }
  const policy = actual.get('.ghostbound/policy.json').bytes;
  const manifestBytes = actual.get('.ghostbound/manifest.json').bytes;
  const manifest = validateManifest(strictJSON(manifestBytes, 16777216), policy);
  check(jsonBytes(manifest).equals(manifestBytes), 'publish blocked: noncanonical publication manifest');
  return { actual, manifest, manifestBytes, policyBytes: policy };
}

function verifyPreviousTree(target, tree) {
  const actual = readTree(target, tree);
  const policyBytes = actual.get('.ghostbound/policy.json')?.bytes;
  const manifestBytes = actual.get('.ghostbound/manifest.json')?.bytes;
  check(policyBytes && manifestBytes, 'publish blocked: previous tree is not a GHOSTBOUND mirror');
  const manifest = validateManifest(strictJSON(manifestBytes, 16777216), policyBytes);
  check(jsonBytes(manifest).equals(manifestBytes), 'publish blocked: previous manifest is not canonical');
  const expected = expectedMirror({ manifest, manifestBytes, policyBytes });
  check(actual.size === expected.size && [...expected.keys()].every(path => actual.has(path)), 'publish blocked: previous tree ownership mismatch');
  for (const [path, item] of expected) {
    const found = actual.get(path);
    check(found.mode === item.mode && found.bytes.length === item.bytes && found.sha256 === item.sha256, 'publish blocked: previous tree bytes mismatch');
  }
  return { actual, manifest, manifestBytes, policyBytes };
}

function buildTree(target, mirror, out) {
  const work = mkdtempSync(join(tmpdir(), 'ghostbound-publish-'));
  const index = join(work, 'index');
  const env = { GIT_INDEX_FILE: index };
  try {
    localGit(target.repo, ['read-tree', '--empty'], { env });
    const entries = [...mirror.manifest.files.map(record => ({ path: record.destination, mode: record.gitMode, bytes: readFileSync(join(out, record.destination)) })),
      { path: '.ghostbound/manifest.json', mode: '100644', bytes: mirror.manifestBytes },
      { path: '.ghostbound/policy.json', mode: '100644', bytes: mirror.policyBytes }];
    for (const entry of entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
      const oid = localGit(target.repo, ['hash-object', '-w', '--stdin'], { input: entry.bytes, maxBuffer: entry.bytes.length + 1024 }).toString().trim();
      check(validOid(oid, target.format), 'publish blocked: invalid target blob');
      localGit(target.repo, ['update-index', '--add', '--index-info'], { env, input: Buffer.from(`${entry.mode} ${oid}\t${entry.path}\n`) });
    }
    const tree = localGit(target.repo, ['write-tree'], { env, maxBuffer: 4096 }).toString().trim();
    check(validOid(tree, target.format), 'publish blocked: invalid target tree');
    return tree;
  } finally { rmSync(work, { recursive: true, force: true }); }
}

function commitDiff(target, commit) {
  const parts = localGit(target.repo, ['diff-tree', '--root', '--no-commit-id', '--name-status', '--no-renames', '-r', '-z', commit], { maxBuffer: 33554432 }).toString().split('\0').filter(Boolean);
  const result = { create: [], update: [], delete: [] };
  for (let i = 0; i < parts.length; i += 2) {
    const status = parts[i]; const path = parts[i + 1];
    check(['A', 'M', 'D'].includes(status) && path, 'publish blocked: unsupported commit diff');
    result[status === 'A' ? 'create' : status === 'M' ? 'update' : 'delete'].push(path);
  }
  for (const key of Object.keys(result)) result[key].sort();
  return result;
}

function sameDelta(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

export function publish(view) {
  check(view.publish, 'publish configuration required');
  const mirror = verifyMirror(view.out);
  verify({ out: view.out, repo: view.source.repo, commit: view.source.commit, policy: view.policy });
  const target = configuredTarget(view);
  disjoint(view.source.repo, target.repo); disjoint(view.out, target.repo);
  const ref = `refs/ghostbound/views/${view.name}`;
  const previousCommit = commitAt(target.repo, ref, target.format);
  const head = commitAt(target.repo, 'HEAD', target.format);
  const branch = localGit(target.repo, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { maxBuffer: 4096 }).toString().trim();
  check(branch === view.publish.branch, 'publish blocked: wrong branch');
  if (!target.bare) {
    const clean = localGit(target.repo, ['status', '--porcelain=v1', '--untracked-files=all'], { maxBuffer: 33554432 }).toString();
    check(clean.length === 0, 'publish blocked: target is dirty');
  }
  const baseRemote = remoteTip(target, view);
  if (!previousCommit) {
    check(!head && !baseRemote, 'publish blocked: existing publication state cannot be adopted');
  } else {
    check(!head || tryLocalGit(target.repo, ['merge-base', '--is-ancestor', head, previousCommit], { maxBuffer: 1024 }).ok, 'publish blocked: local target HEAD inconsistent with publication ref');
    check(baseRemote === previousCommit, 'publish blocked: remote drift');
  }
  const previousTree = previousCommit ? localGit(target.repo, ['rev-parse', '--verify', `${previousCommit}^{tree}`], { maxBuffer: 4096 }).toString().trim() : null;
  const previous = previousTree ? verifyPreviousTree(target, previousTree) : null;
  const generatedTree = buildTree(target, mirror, view.out);
  verifyTree(target, generatedTree, mirror);
  const beforeMap = previous ? filesystemMap(previous.manifestBytes, previous.policyBytes, previous.manifest) : new Map();
  const afterMap = filesystemMap(mirror.manifestBytes, mirror.policyBytes, mirror.manifest);
  const planned = diffMaps(beforeMap, afterMap);
  if (previous && generatedTree === previousTree) {
    check(remoteTip(target, view) === previousCommit, 'publish blocked: remote drift');
    return { published: false, commit: previousCommit, remoteTip: previousCommit, changes: planned };
  }
  const parent = previousCommit ? ['-p', previousCommit] : [];
  const message = `ghostbound: publish ${view.name} from ${view.source.commit.slice(0, 12)}`;
  const newCommit = localGit(target.repo, ['commit-tree', generatedTree, ...parent, '-m', message], { maxBuffer: 4096 }).toString().trim();
  check(validOid(newCommit, target.format), 'publish blocked: invalid publication commit');
  check(sameDelta(planned, commitDiff(target, newCommit)), 'publish blocked: publication delta mismatch');
  check(remoteTip(target, view) === baseRemote, 'publish blocked: remote drift');
  let pushError = null;
  try { networkRunner(target.repo, ['push', '--no-verify', view.publish.remote, `${newCommit}:refs/heads/${view.publish.branch}`], { maxBuffer: 33554432 }); }
  catch (error) { pushError = error; }
  let confirmed;
  try { confirmed = remoteTip(target, view); }
  catch { throw new Error('publish blocked: remote state unavailable after push'); }
  if (confirmed !== newCommit) throw new Error(pushError ? 'publish blocked: push failed' : 'publish blocked: remote confirmation mismatch');
  const oldRef = previousCommit ?? '0'.repeat(target.format === 'sha1' ? 40 : 64);
  localGit(target.repo, ['update-ref', ref, newCommit, oldRef], { maxBuffer: 4096 });
  return { published: true, commit: newCommit, remoteTip: confirmed, changes: planned };
}
