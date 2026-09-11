import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, fail, sha256, strictJSON } from './common.mjs';

export const CONFIG = fileURLToPath(new URL('../config/gitleaks.toml', import.meta.url));
export const configDigest = () => sha256(readFileSync(CONFIG));

export function privateDirectory(path) {
  if (process.platform !== 'win32') { chmodSync(path, 0o700); return; }
  try {
    const opts = { encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] };
    const identity = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], opts);
    const sid = identity.match(/S-1-\d+(?:-\d+)+/);
    check(sid, 'cannot identify staging owner');
    execFileSync('icacls.exe', [path, '/inheritance:r', '/grant:r', `*${sid[0]}:(OI)(CI)F`], opts);
  } catch { fail('cannot restrict staging permissions'); }
}

// Process seam is exported for targeted failure tests; the CLI never accepts a scanner override.
export function scannerProcess(args, cwd, executable = 'gitleaks', prefix = []) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(?:GITLEAKS_|GIT_)/i.test(k)));
  return spawnSync(executable, [...prefix, ...args], { cwd, env, windowsHide: true, timeout: 120000, maxBuffer: 4194304, stdio: ['ignore', 'pipe', 'pipe'] });
}
export function assertScanResult(result) {
  check(!result.error && !result.signal && result.status === 0, 'secret scan blocked (finding, missing scanner, timeout or scanner error)');
  const report = strictJSON(result.stdout, 4194304);
  check(Array.isArray(report) && report.length === 0, 'secret scan report blocked');
}
export function scan(entries, policyBytes, work) {
  const dir = join(work, 'scan'); mkdirSync(dir, { mode: 0o700 });
  // Neutral names avoid source ignore files, extension/path allowlists and archive handling.
  const surfaces = [...entries.map(e => Buffer.concat([Buffer.from(e.source + '\n' + e.destination + '\n'), e.content])), policyBytes];
  surfaces.forEach((bytes, i) => writeFileSync(join(dir, `surface-${String(i).padStart(6, '0')}.txt`), bytes, { flag: 'wx', mode: 0o600 }));
  const versionResult = scannerProcess(['version'], work);
  check(!versionResult.error && !versionResult.signal && versionResult.status === 0, 'Gitleaks version check failed');
  const version = versionResult.stdout.toString().trim();
  check(/^8\.(?:[3-9]\d|[1-9]\d{2,})\.\d+$/.test(version), 'Gitleaks >=8.30.0 and <9 required');
  const result = scannerProcess(['dir', '--config', CONFIG, '--redact=100', '--ignore-gitleaks-allow', '--gitleaks-ignore-path', work,
    '--max-target-megabytes=0', '--max-decode-depth=5', '--max-archive-depth=0', '--timeout=110', '--exit-code=23',
    '--no-banner', '--no-color', '--log-level=error', '--report-format=json', '--report-path=-', dir], work);
  assertScanResult(result);
  return { engine: 'gitleaks', version, configSha256: configDigest(), result: 'passed' };
}
