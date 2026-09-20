import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { check, fail, textContent, sha256 } from './common.mjs';
import { confinedRoot } from './paths.mjs';
import { select } from './policy.mjs';

export function gitEnv() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k)));
  return { ...env, GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
}
function git(repo, args, maxBuffer = 33554432) {
  try {
    return execFileSync('git', ['--no-replace-objects', '--no-lazy-fetch', '-c', 'protocol.allow=never', '-C', repo, ...args], {
      env: gitEnv(), timeout: 30000, maxBuffer, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
  } catch { fail('Git operation failed (check local objects, permissions and safe.directory)'); }
}
export function resolveSourceRef(repoInput, ref) {
  const repo = confinedRoot(repoInput);
  const format = git(repo, ['rev-parse', '--show-object-format']).toString().trim();
  check(['sha1', 'sha256'].includes(format), 'unsupported Git object format');
  let commit = ref;
  if (ref === 'HEAD') commit = git(repo, ['rev-parse', '--verify', 'HEAD^{commit}'], 1024).toString().trim();
  check(validOid(commit, format), 'view did not resolve to a full commit OID');
  check(git(repo, ['cat-file', '-t', commit], 1024).toString().trim() === 'commit', 'view ref is not a commit');
  return commit;
}
export function validOid(oid, format) { return typeof oid === 'string' && new RegExp(`^[0-9a-f]{${format === 'sha1' ? 40 : 64}}$`).test(oid); }
export function parseTree(bytes, format) {
  const entries = []; let start = 0;
  while (start < bytes.length) {
    const end = bytes.indexOf(0, start); check(end !== -1, 'unterminated tree entry');
    const tab = bytes.indexOf(9, start); check(tab > start && tab < end, 'invalid tree entry');
    const match = /^(\d{6}) (blob|commit) ([0-9a-f]+)$/.exec(bytes.subarray(start, tab).toString('ascii'));
    check(match && validOid(match[3], format), 'invalid tree entry');
    entries.push({ mode: match[1], type: match[2], oid: match[3], path: bytes.subarray(tab + 1, end) });
    check(entries.length <= 200000, 'tree entry limit'); start = end + 1;
  }
  return entries;
}
export function snapshot(repoInput, commit, policy, limits) {
  const repo = confinedRoot(repoInput);
  const format = git(repo, ['rev-parse', '--show-object-format']).toString().trim();
  check(['sha1', 'sha256'].includes(format), 'unsupported Git object format');
  check(validOid(commit, format), 'full lowercase commit OID required');
  const bare = git(repo, ['rev-parse', '--is-bare-repository']).toString().trim();
  const actualRoot = git(repo, ['rev-parse', bare === 'true' ? '--absolute-git-dir' : '--show-toplevel']).toString().trim();
  check(realpathSync.native(resolve(actualRoot)) === realpathSync.native(repo), 'repo must name the repository root');
  check(git(repo, ['cat-file', '-t', commit], 1024).toString().trim() === 'commit', 'OID is not a commit');
  const tree = git(repo, ['rev-parse', '--verify', `${commit}^{tree}`], 1024).toString().trim();
  check(validOid(tree, format), 'invalid tree OID');
  const entries = select(parseTree(git(repo, ['ls-tree', '-r', '-z', '--full-tree', tree]), format), policy);
  check(entries.length <= limits.maxFiles, 'file count limit');
  let total = 0;
  for (const entry of entries) {
    const rawSize = git(repo, ['cat-file', '-s', entry.gitBlobOid], 1024).toString().trim();
    check(/^\d+$/.test(rawSize), 'invalid blob size'); const size = Number(rawSize);
    check(Number.isSafeInteger(size) && size <= limits.maxFileBytes, 'file byte limit');
    total += size; check(total <= limits.maxTotalBytes, 'total byte limit');
    const content = git(repo, ['cat-file', 'blob', entry.gitBlobOid], limits.maxFileBytes + 1);
    check(content.length === size, 'blob length mismatch'); textContent(content);
    const oid = createHash(format).update(Buffer.from(`blob ${size}\0`)).update(content).digest('hex');
    check(oid === entry.gitBlobOid, 'blob identity mismatch');
    Object.assign(entry, { bytes: size, sha256: sha256(content), content });
  }
  return { repo, source: { objectFormat: format, commit, tree }, entries };
}
