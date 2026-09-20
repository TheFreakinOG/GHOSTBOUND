import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { VERSION, LIMITS, check, keys, sha256, strictJSON, jsonBytes, compare, textContent } from './common.mjs';
import { safePath, checkCollisions, confinedRoot } from './paths.mjs';
import { parsePolicy, select } from './policy.mjs';
import { validOid } from './git.mjs';
import { configDigest } from './secrets.mjs';

export const MANIFEST = '.ghostbound/manifest.json';
export const POLICY = '.ghostbound/policy.json';
export const aggregate = files => sha256(Buffer.from(JSON.stringify(files.map(f => [f.destination, f.gitMode, f.sha256]))));
export const records = entries => entries.map(({ content, ...record }) => record);
export function makeManifest(source, policyBytes, entries, secretScan) {
  const files = records(entries);
  return { schema: 'ghostbound.manifest/v1', tool: { name: 'ghostbound', version: VERSION }, source,
    policy: { sha256: sha256(policyBytes), snapshot: POLICY }, secretScan, files,
    mirror: { fileCount: files.length, totalBytes: files.reduce((n, f) => n + f.bytes, 0), sha256: aggregate(files) } };
}
function digest(value) { check(typeof value === 'string' && /^[0-9a-f]{64}$/.test(value), 'invalid digest'); }
export function validateManifest(m, policyBytes) {
  keys(m, ['schema', 'tool', 'source', 'policy', 'secretScan', 'files', 'mirror']);
  check(m.schema === 'ghostbound.manifest/v1', 'unsupported manifest schema');
  keys(m.tool, ['name', 'version']); check(m.tool.name === 'ghostbound' && ['0.1.0', '0.2.0'].includes(m.tool.version), 'unsupported tool version');
  keys(m.source, ['objectFormat', 'commit', 'tree']);
  check(['sha1', 'sha256'].includes(m.source.objectFormat) && validOid(m.source.commit, m.source.objectFormat) && validOid(m.source.tree, m.source.objectFormat), 'invalid source identity');
  keys(m.policy, ['sha256', 'snapshot']); digest(m.policy.sha256);
  check(m.policy.snapshot === POLICY && m.policy.sha256 === sha256(policyBytes), 'policy digest mismatch');
  const { policy, limits } = parsePolicy(policyBytes);
  keys(m.secretScan, ['engine', 'version', 'configSha256', 'result']);
  check(m.secretScan.engine === 'gitleaks' && /^8\.(?:[3-9]\d|[1-9]\d{2,})\.\d+$/.test(m.secretScan.version) && m.secretScan.result === 'passed', 'invalid scanner evidence');
  digest(m.secretScan.configSha256); check(m.secretScan.configSha256 === configDigest(), 'scanner config mismatch');
  check(Array.isArray(m.files) && m.files.length > 0 && m.files.length <= limits.maxFiles, 'invalid manifest files');
  let total = 0;
  for (let i = 0; i < m.files.length; i++) {
    const f = m.files[i]; keys(f, ['source', 'destination', 'gitMode', 'gitBlobOid', 'bytes', 'sha256']);
    safePath(f.source, { source: true }); safePath(f.destination); digest(f.sha256);
    check(['100644', '100755'].includes(f.gitMode) && validOid(f.gitBlobOid, m.source.objectFormat), 'invalid blob identity');
    check(Number.isSafeInteger(f.bytes) && f.bytes >= 0 && f.bytes <= limits.maxFileBytes, 'invalid byte count');
    check(i === 0 || compare(m.files[i - 1].destination, f.destination) < 0, 'noncanonical file order'); total += f.bytes;
  }
  check(total <= limits.maxTotalBytes, 'total byte limit'); checkCollisions(m.files.map(f => f.destination));
  const mapped = select(m.files.map(f => ({ path: Buffer.from(f.source), mode: f.gitMode, oid: f.gitBlobOid, type: 'blob' })), policy);
  check(JSON.stringify(mapped) === JSON.stringify(m.files.map(({ bytes, sha256: hash, ...f }) => f)), 'manifest policy mapping mismatch');
  keys(m.mirror, ['fileCount', 'totalBytes', 'sha256']); digest(m.mirror.sha256);
  check(m.mirror.fileCount === m.files.length && m.mirror.totalBytes === total && m.mirror.sha256 === aggregate(m.files), 'mirror aggregate mismatch');
  return m;
}
function boundedRead(path, max) {
  const st = lstatSync(path); check(st.isFile() && !st.isSymbolicLink() && st.nlink === 1 && st.size <= max, 'invalid mirror file');
  return readFileSync(path);
}
export function verifyMirror(out) {
  const root = confinedRoot(out);
  const metadata = lstatSync(join(root, '.ghostbound'));
  check(metadata.isDirectory() && !metadata.isSymbolicLink(), 'invalid metadata directory');
  const policyBytes = boundedRead(join(root, POLICY), 1048576);
  const manifestBytes = boundedRead(join(root, MANIFEST), 16777216);
  const m = validateManifest(strictJSON(manifestBytes, 16777216), policyBytes);
  check(jsonBytes(m).equals(manifestBytes), 'manifest serialization is not canonical');
  const files = new Map([...m.files.map(f => [f.destination, f]), [MANIFEST, null], [POLICY, null]]);
  const dirs = new Set(['.ghostbound']);
  for (const dest of files.keys()) {
    const parts = dest.split('/'); for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  let count = 0;
  function walk(rel) {
    for (const name of readdirSync(join(root, rel))) {
      check(++count <= LIMITS.maxFiles * 33 + 3, 'mirror entry limit');
      const dest = rel ? rel + '/' + name : name; const path = join(root, dest); const st = lstatSync(path);
      check(!st.isSymbolicLink(), 'mirror link forbidden');
      if (st.isDirectory()) { check(dirs.delete(dest), 'unexpected directory'); walk(dest); }
      else {
        check(st.isFile() && st.nlink === 1 && files.has(dest), 'unexpected or special file');
        const f = files.get(dest); files.delete(dest);
        if (f) {
          check(st.size === f.bytes, 'file length mismatch'); const bytes = boundedRead(path, f.bytes);
          check(sha256(bytes) === f.sha256, 'file hash mismatch'); textContent(bytes);
          const oid = createHash(m.source.objectFormat).update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex');
          check(oid === f.gitBlobOid, 'blob hash mismatch');
          if (process.platform !== 'win32') check((st.mode & 0o111) === (f.gitMode === '100755' ? 0o111 : 0), 'executable mode mismatch');
        }
      }
    }
  }
  walk(''); check(files.size === 0 && dirs.size === 0, 'missing mirror entry');
  return { manifest: m, manifestBytes, policyBytes };
}
