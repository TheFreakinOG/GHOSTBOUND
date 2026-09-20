import { readFileSync, lstatSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { check, strictJSON } from './common.mjs';
import { confinedRoot } from './paths.mjs';
import { resolveSourceRef } from './git.mjs';

const VIEW_SIZE = 1048576;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const REMOTE_NAME = NAME;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function pathFromView(viewFile, value) {
  check(typeof value === 'string' && value.length > 0, 'invalid view path');
  return resolve(isAbsolute(value) ? value : resolve(dirname(viewFile), value));
}

function safeBranch(value) {
  check(typeof value === 'string' && BRANCH.test(value), 'invalid publish branch');
  check(!value.includes('..') && !value.includes('//') && !value.includes('@{') && !value.endsWith('/') && !value.endsWith('.') && !value.split('/').some(part => part === '.' || part === '' || part.endsWith('.lock')), 'invalid publish branch');
  return value;
}

export function readView(file) {
  const viewFile = resolve(file);
  const st = lstatSync(viewFile);
  check(st.isFile() && !st.isSymbolicLink() && st.size <= VIEW_SIZE, 'invalid view file');
  const bytes = readFileSync(viewFile);
  const value = strictJSON(bytes, VIEW_SIZE);
  const optional = ['publish'];
  check(value && typeof value === 'object' && !Array.isArray(value), 'invalid view');
  check(Object.keys(value).every(key => ['schema', 'name', 'source', 'policy', 'out', ...optional].includes(key)), 'unknown or missing view key');
  check(value.schema === 'ghostbound.view/v1', 'unsupported view schema');
  check(typeof value.name === 'string' && NAME.test(value.name), 'invalid view name');
  check(value.source && typeof value.source === 'object' && !Array.isArray(value.source), 'invalid view source');
  check(Object.keys(value.source).length === 2 && typeof value.source.repo === 'string' && typeof value.source.ref === 'string', 'invalid view source');
  check(value.source.ref === 'HEAD' || OID.test(value.source.ref), 'view source ref must be HEAD or a full OID');
  check(typeof value.policy === 'string' && value.policy.length > 0 && typeof value.out === 'string' && value.out.length > 0, 'missing view path');
  const view = {
    schema: value.schema,
    name: value.name,
    file: viewFile,
    source: { repo: pathFromView(viewFile, value.source.repo), ref: value.source.ref },
    policy: pathFromView(viewFile, value.policy),
    out: pathFromView(viewFile, value.out),
  };
  if (Object.hasOwn(value, 'publish')) {
    const publish = value.publish;
    check(publish && typeof publish === 'object' && !Array.isArray(publish), 'invalid publish config');
    check(Object.keys(publish).length === 4 && ['repo', 'remote', 'url', 'branch'].every(key => Object.hasOwn(publish, key)), 'invalid publish config');
    check(typeof publish.repo === 'string' && publish.repo.length > 0 && typeof publish.url === 'string' && publish.url.length > 0 && !/[\u0000-\u001f\u007f]/u.test(publish.url), 'invalid publish config');
    check(REMOTE_NAME.test(publish.remote), 'invalid publish remote');
    view.publish = { repo: pathFromView(viewFile, publish.repo), remote: publish.remote, url: publish.url, branch: safeBranch(publish.branch) };
  }
  confinedRoot(view.source.repo);
  const policyStat = lstatSync(view.policy);
  check(policyStat.isFile() && !policyStat.isSymbolicLink() && policyStat.size <= VIEW_SIZE, 'invalid view policy path');
  confinedRoot(view.out, { missing: true });
  if (view.publish) confinedRoot(view.publish.repo);
  return view;
}

export function resolveView(view) {
  const commit = resolveSourceRef(view.source.repo, view.source.ref);
  return { ...view, source: { ...view.source, commit } };
}
