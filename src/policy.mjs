import { readFileSync, lstatSync } from 'node:fs';
import { check, keys, strictJSON, LIMITS, compare, utf8 } from './common.mjs';
import { safePath, checkCollisions } from './paths.mjs';

export function parsePolicy(bytes) {
  const policy = strictJSON(bytes); keys(policy, ['schema', 'include'], ['limits']);
  check(policy.schema === 'ghostbound.policy/v1', 'unsupported policy schema');
  check(Array.isArray(policy.include) && policy.include.length > 0 && policy.include.length <= LIMITS.maxFiles, 'invalid include rules');
  for (const rule of policy.include) {
    keys(rule, [], ['path', 'tree', 'to']);
    check(Object.hasOwn(rule, 'path') !== Object.hasOwn(rule, 'tree'), 'rule must select path or tree');
    safePath(rule.path ?? rule.tree, { source: true });
    if (Object.hasOwn(rule, 'to')) safePath(rule.to);
  }
  const limits = { ...LIMITS };
  if (Object.hasOwn(policy, 'limits')) {
    keys(policy.limits, [], Object.keys(LIMITS));
    for (const [key, n] of Object.entries(policy.limits)) {
      check(Number.isSafeInteger(n) && n > 0 && n <= LIMITS[key], 'invalid resource limit'); limits[key] = n;
    }
  }
  return { policy, limits };
}
export function readPolicy(file) {
  const st = lstatSync(file); check(st.isFile() && !st.isSymbolicLink() && st.size <= 1048576, 'invalid policy file');
  const bytes = readFileSync(file); return { bytes, ...parsePolicy(bytes) };
}
export function select(entries, policy) {
  const selected = []; const seen = new Set();
  const sorted = [...entries].sort((a, b) => Buffer.compare(a.path, b.path));
  const lowerBound = prefix => {
    let low = 0; let high = sorted.length;
    while (low < high) { const mid = (low + high) >>> 1; if (Buffer.compare(sorted[mid].path, prefix) < 0) low = mid + 1; else high = mid; }
    return low;
  };
  for (const rule of policy.include) {
    const prefix = Buffer.from(rule.path ?? rule.tree);
    // Raw comparison identifies candidate scope; validate decoded paths before mapping.
    const matches = []; const exact = sorted[lowerBound(prefix)];
    if (exact?.path.equals(prefix)) matches.push(exact);
    if (rule.tree !== undefined) {
      const subtree = Buffer.concat([prefix, Buffer.from('/')]);
      for (let i = lowerBound(subtree); i < sorted.length && sorted[i].path.subarray(0, subtree.length).equals(subtree); i++) matches.push(sorted[i]);
    }
    check(matches.length > 0, 'policy selection has no matches');
    for (const e of matches) {
      const source = safePath(utf8(e.path), { source: true });
      check(e.type === 'blob' && ['100644', '100755'].includes(e.mode), 'selected Git entry is not a regular blob');
      check(rule.tree === undefined || source !== rule.tree, 'tree rule targets a file');
      check(!seen.has(source), 'overlapping source rules'); seen.add(source);
      const destination = safePath(rule.path !== undefined ? (rule.to ?? source) : (rule.to === undefined ? source : rule.to + source.slice(rule.tree.length)));
      selected.push({ source, destination, gitMode: e.mode, gitBlobOid: e.oid });
    }
  }
  checkCollisions(selected.map(e => e.destination));
  return selected.sort((a, b) => compare(a.destination, b.destination));
}
