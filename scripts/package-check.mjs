import { readFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
const [pack] = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const roots = ['src/', 'config/', 'schemas/', 'docs/', 'examples/'];
const exact = ['package.json', 'README.md', 'LICENSE', 'SECURITY.md', 'THIRD_PARTY.md'];
for (const f of pack.files) assert.ok(exact.includes(f.path) || roots.some(r => f.path.startsWith(r)), 'unexpected package path');
const temp = realpathSync.native(mkdtempSync(join(tmpdir(), 'ghostbound-package-')));
try {
  // stdin avoids GNU tar treating Windows drive letters as remote archive hosts.
  execFileSync('tar', ['-xzf', '-'], { cwd: temp, input: readFileSync(resolve(pack.filename)) });
  const help = execFileSync(process.execPath, [join(temp, 'package/src/cli.mjs'), '--help'], { encoding: 'utf8' });
  assert.match(help, /plan\|materialize/);
  for (const f of pack.files) {
    const bytes = readFileSync(join(temp, 'package', f.path));
    const localPath = /(?:^|[\s"'(])[A-Za-z]:[\\/]|\/(?:home|Users)\/[^/\s]+/;
    assert.ok(!localPath.test(bytes.toString('utf8')), 'local machine path in package');
  }
  console.log(`Package inventory and extracted CLI passed (${pack.files.length} files)`);
} finally { rmSync(temp, { recursive: true, force: true }); }
