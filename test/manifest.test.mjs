import test from 'node:test';
import assert from 'node:assert/strict';
import { validateManifest, makeManifest } from '../src/manifest.mjs';
import { jsonBytes, sha256 } from '../src/common.mjs';
import { configDigest } from '../src/secrets.mjs';

test('manifest producer versions are explicit', () => {
  const policy = jsonBytes({ schema: 'ghostbound.policy/v1', include: [{ path: 'README.md' }] });
  const content = Buffer.from('# synthetic\n');
  const entry = { source: 'README.md', destination: 'README.md', gitMode: '100644', gitBlobOid: 'a'.repeat(40), bytes: content.length, sha256: sha256(content), content };
  const source = { objectFormat: 'sha1', commit: 'b'.repeat(40), tree: 'c'.repeat(40) };
  const scan = { engine: 'gitleaks', version: '8.30.1', configSha256: configDigest(), result: 'passed' };
  const manifest = makeManifest(source, policy, [entry], scan); manifest.tool.version = '0.1.0';
  assert.equal(validateManifest(manifest, policy).tool.version, '0.1.0');
  assert.throws(() => validateManifest({ ...manifest, tool: { name: 'ghostbound', version: '0.3.0' } }, policy));
});
