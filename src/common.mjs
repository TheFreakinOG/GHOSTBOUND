import { createHash } from 'node:crypto';

export const VERSION = '0.1.0';
export const LIMITS = Object.freeze({ maxFiles: 10000, maxFileBytes: 4194304, maxTotalBytes: 67108864 });
export function fail(code) { throw new Error(code); }
export function check(ok, code) { if (!ok) fail(code); }
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const jsonBytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
export const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
export function utf8(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { fail('invalid UTF-8'); }
}
export function keys(value, required, optional = []) {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), 'expected object');
  check(required.every(k => Object.hasOwn(value, k)) && Object.keys(value).every(k => [...required, ...optional].includes(k)), 'unknown or missing key');
}
export function textContent(bytes) {
  const text = utf8(bytes);
  check(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(text), 'binary or control content unsupported');
  check(!text.replace(/^\uFEFF/, '').startsWith('version https://git-lfs.github.com/spec/v1'), 'LFS pointer unsupported');
  return text;
}

// Bounded grammar walk rejects duplicate decoded keys before JSON.parse.
export function strictJSON(bytes, maxBytes = 1048576) {
  check(bytes.length <= maxBytes, 'JSON size limit');
  const text = utf8(bytes); let i = 0;
  const ws = () => { while (/[\x20\t\r\n]/.test(text[i] ?? '\0')) i++; };
  const string = () => {
    check(text[i] === '"', 'invalid JSON'); const start = i++;
    while (i < text.length) {
      if (text[i] === '\\') { i += 2; continue; }
      if (text[i++] === '"') {
        let value; try { value = JSON.parse(text.slice(start, i)); } catch { fail('invalid JSON'); }
        check(!/[\uD800-\uDFFF]/u.test(value), 'unpaired Unicode surrogate'); return value;
      }
    }
    fail('invalid JSON');
  };
  function value(depth) {
    check(depth <= 32, 'JSON depth limit'); ws();
    if (text[i] === '"') { string(); return; }
    if (text[i] === '{') {
      i++; ws(); const seen = new Set();
      if (text[i] === '}') { i++; return; }
      while (true) {
        ws(); const key = string(); check(!seen.has(key), 'duplicate JSON key'); seen.add(key);
        ws(); check(text[i++] === ':', 'invalid JSON'); value(depth + 1); ws();
        if (text[i] === '}') { i++; return; } check(text[i++] === ',', 'invalid JSON');
      }
    }
    if (text[i] === '[') {
      i++; ws(); if (text[i] === ']') { i++; return; }
      while (true) { value(depth + 1); ws(); if (text[i] === ']') { i++; return; } check(text[i++] === ',', 'invalid JSON'); }
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(i));
    check(match, 'invalid JSON'); i += match[0].length;
  }
  value(0); ws(); check(i === text.length, 'invalid JSON');
  try { return JSON.parse(text); } catch { fail('invalid JSON'); }
}
