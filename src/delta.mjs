import { sha256 } from './common.mjs';

export function diffMaps(before, after) {
  const create = [...after.keys()].filter(key => !before.has(key)).sort();
  const update = [...after.keys()].filter(key => before.has(key) && JSON.stringify(before.get(key)) !== JSON.stringify(after.get(key))).sort();
  const deletePaths = [...before.keys()].filter(key => !after.has(key)).sort();
  return { create, update, delete: deletePaths };
}

function recordValue(record) {
  return {
    source: record.source,
    destination: record.destination,
    gitMode: record.gitMode,
    gitBlobOid: record.gitBlobOid,
    bytes: record.bytes,
    sha256: record.sha256,
  };
}

export function recordMap(manifest) {
  return new Map((manifest?.files ?? []).map(record => [record.destination, recordValue(record)]));
}

export function disclosureDelta(previousManifest, desiredManifest) {
  const diff = diffMaps(recordMap(previousManifest), recordMap(desiredManifest));
  return {
    newlyExposed: diff.create,
    changedExposed: diff.update,
    noLongerExposed: diff.delete,
  };
}

export function filesystemMap(manifestBytes, policyBytes, manifest) {
  const files = new Map((manifest?.files ?? []).map(record => [record.destination, { bytes: record.bytes, sha256: record.sha256, gitMode: record.gitMode }]));
  if (manifestBytes) files.set('.ghostbound/manifest.json', { sha256: sha256(manifestBytes), gitMode: '100644' });
  if (policyBytes) files.set('.ghostbound/policy.json', { sha256: sha256(policyBytes), gitMode: '100644' });
  return files;
}
