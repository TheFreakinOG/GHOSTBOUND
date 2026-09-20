import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readdirSync, renameSync, rmSync, lstatSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { check, jsonBytes, sha256 } from './common.mjs';
import { confinedRoot, disjoint, statMaybe, safePath } from './paths.mjs';
import { readPolicy } from './policy.mjs';
import { snapshot } from './git.mjs';
import { scan, privateDirectory } from './secrets.mjs';
import { makeManifest, verifyMirror, records, MANIFEST, POLICY } from './manifest.mjs';
import { diffMaps, disclosureDelta, filesystemMap } from './delta.mjs';

function existing(out) {
  confinedRoot(out, { missing: true });
  if (!statMaybe(out)) return { kind: 'absent' };
  if (readdirSync(out).length === 0) return { kind: 'empty' };
  return { kind: 'mirror', ...verifyMirror(out) };
}
function sameExisting(a, b) {
  check(a.kind === b.kind, 'output changed during operation');
  if (a.kind === 'mirror') check(a.manifestBytes.equals(b.manifestBytes) && a.policyBytes.equals(b.policyBytes), 'output changed during operation');
}
function changes(old, manifest, policyBytes) {
  return diffMaps(filesystemMap(old.manifestBytes, old.policyBytes, old.manifest), filesystemMap(jsonBytes(manifest), policyBytes, manifest));
}

// Only transaction-owned temporary directories reach this cleanup function.
function removeOwned(path, parent) {
  check(dirname(path) === parent && basename(path).startsWith('.ghostbound-'), 'invalid cleanup target');
  const st = lstatSync(path); check(st.isDirectory() && !st.isSymbolicLink(), 'unsafe cleanup target');
  rmSync(path, { recursive: true });
}

export function run({ repo, commit, policy, out, materialize = false }) {
  out = confinedRoot(out, { missing: true }); repo = confinedRoot(repo); disjoint(repo, out);
  safePath(basename(out));
  const input = readPolicy(policy); const source = snapshot(repo, commit, input.policy, input.limits);
  const old = existing(out); const parent = dirname(out);
  const work = mkdtempSync(join(parent, '.ghostbound-stage-')); const stage = join(work, 'mirror');
  let preserve = false;
  try {
    privateDirectory(work); mkdirSync(stage, { mode: 0o700 });
    for (const f of source.entries) {
      const dest = join(stage, f.destination); mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
      writeFileSync(dest, f.content, { flag: 'wx', mode: 0o600 });
      if (process.platform !== 'win32') chmodSync(dest, f.gitMode === '100755' ? 0o755 : 0o644);
    }
    const secretScan = scan(source.entries, input.bytes, work);
    const manifest = makeManifest(source.source, input.bytes, source.entries, secretScan);
    mkdirSync(join(stage, '.ghostbound'), { mode: 0o700 });
    writeFileSync(join(stage, POLICY), input.bytes, { flag: 'wx', mode: 0o600 });
    writeFileSync(join(stage, MANIFEST), jsonBytes(manifest), { flag: 'wx', mode: 0o600 });
    verifyMirror(stage); sameExisting(old, existing(out));
    const delta = changes(old, manifest, input.bytes);
    if (!materialize) return { applied: false, changes: delta, disclosure: disclosureDelta(old.manifest, manifest), mirror: manifest.mirror, manifest, policyBytes: input.bytes, source: source.source };
    const backup = join(work, 'previous'); let movedOld = false; let installed = false;
    try {
      if (old.kind !== 'absent') { renameSync(out, backup); movedOld = true; }
      renameSync(stage, out); installed = true; verifyMirror(out);
    } catch {
      try {
        if (installed) renameSync(out, stage);
        if (movedOld) renameSync(backup, out);
        sameExisting(old, existing(out));
      } catch { preserve = true; throw new Error('replacement and rollback failed; retain adjacent .ghostbound-stage-* for manual recovery'); }
      throw new Error('replacement failed; previous output restored');
    }
    // Reverify backup before deleting it; concurrent local mutation is outside the threat model.
    if (movedOld) {
      try { sameExisting(old, existing(backup)); } catch { preserve = true; throw new Error('output installed; backup changed and was retained'); }
    }
    return { applied: true, changes: delta, disclosure: disclosureDelta(old.manifest, manifest), mirror: manifest.mirror, manifest, policyBytes: input.bytes, source: source.source };
  } finally { if (!preserve) removeOwned(work, parent); }
}

export function verify({ out, repo, commit, policy }) {
  const result = verifyMirror(out);
  if (repo !== undefined || commit !== undefined || policy !== undefined) {
    check(repo !== undefined && commit !== undefined && policy !== undefined, 'source verification requires repo, commit and policy');
    const input = readPolicy(policy); const source = snapshot(repo, commit, input.policy, input.limits); disjoint(source.repo, confinedRoot(out));
    check(input.bytes.equals(result.policyBytes), 'source policy mismatch');
    check(JSON.stringify(source.source) === JSON.stringify(result.manifest.source), 'source commit or tree mismatch');
    check(JSON.stringify(records(source.entries)) === JSON.stringify(result.manifest.files), 'source files mismatch');
  }
  return { verified: true, sourceProvenance: repo !== undefined, mirror: result.manifest.mirror };
}
