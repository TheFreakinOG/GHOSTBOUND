import { lstatSync, realpathSync } from 'node:fs';
import { resolve, parse, join, relative, isAbsolute, sep } from 'node:path';
import { check } from './common.mjs';

export function safePath(value, { source = false } = {}) {
  check(typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 1024, 'unsafe relative path');
  check(value === value.normalize('NFC') && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value), 'noncanonical path');
  check(!/[\\<>:"|?*]/u.test(value), 'unsafe path character');
  const parts = value.split('/');
  check(parts.length <= 32 && parts.every(p => p && p !== '.' && p !== '..' && !/[. ]$/.test(p) && Buffer.byteLength(p) <= 240), 'unsafe path segment');
  check(parts.every(p => !/^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(p)), 'reserved device path');
  check(parts.every(p => p.toLowerCase() !== '.git'), 'reserved Git path');
  if (!source) check(parts.every(p => p.toLowerCase() !== '.ghostbound'), 'reserved metadata path');
  return value;
}
export function checkCollisions(paths) {
  const files = new Set(); const dirs = new Map();
  for (const path of paths) {
    safePath(path); const folded = path.normalize('NFC').toUpperCase();
    check(!files.has(folded) && !dirs.has(folded), 'destination collision');
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/'); const key = dir.toUpperCase();
      check(!files.has(key) && (!dirs.has(key) || dirs.get(key) === dir), 'directory collision'); dirs.set(key, dir);
    }
    files.add(folded);
  }
}
export function statMaybe(path) {
  try { return lstatSync(path); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
export function confinedRoot(input, { missing = false } = {}) {
  const path = resolve(input); const root = parse(path).root;
  check(path !== root, 'filesystem root forbidden');
  let cursor = root; const parts = path.slice(root.length).split(/[\\/]/).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    cursor = join(cursor, parts[i]); const st = statMaybe(cursor);
    if (!st) { check(missing && i === parts.length - 1, 'parent directory must exist'); break; }
    check(!st.isSymbolicLink() && st.isDirectory(), 'root or ancestor is not a real directory');
    const actual = realpathSync.native(cursor);
    check(process.platform === 'win32' ? actual.toLowerCase() === cursor.toLowerCase() : actual === cursor, 'root alias forbidden');
  }
  return path;
}
export function disjoint(a, b) {
  const contains = (root, child) => { const rel = relative(root, child); return !rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep)); };
  check(!contains(a, b) && !contains(b, a), 'source and output must be disjoint');
}
