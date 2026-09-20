import { readdirSync } from 'node:fs';
import { statMaybe } from './paths.mjs';
import { verifyMirror } from './manifest.mjs';
import { planState } from './mirror.mjs';
import { disclosureDelta } from './delta.mjs';
import { check } from './common.mjs';

function outputKind(out) {
  const st = statMaybe(out);
  if (!st) return 'absent';
  check(st.isDirectory() && !st.isSymbolicLink(), 'invalid output root');
  return readdirSync(out).length === 0 ? 'empty' : 'nonempty';
}
export function status(view) {
  const kind = outputKind(view.out);
  let previous = null;
  if (kind === 'nonempty') {
    try { previous = verifyMirror(view.out); }
    catch { return { view: view.name, status: 'INVALID', source: { currentCommit: view.source.commit } }; }
  }
  const planned = planState({ repo: view.source.repo, commit: view.source.commit, policy: view.policy, out: view.out });
  if (!previous) {
    return {
      view: view.name,
      status: 'UNVERIFIABLE',
      source: { currentCommit: view.source.commit },
      policyChanged: false,
      disclosure: planned.disclosure,
      changes: planned.changes,
    };
  }
  const sourceMatch = previous.manifest.source.commit === planned.source.commit;
  const policyChanged = !previous.policyBytes.equals(planned.policyBytes);
  const noChanges = planned.changes.create.length === 0 && planned.changes.update.length === 0 && planned.changes.delete.length === 0;
  return {
    view: view.name,
    status: sourceMatch && !policyChanged && noChanges ? 'CURRENT' : 'STALE',
    source: { currentCommit: planned.source.commit, mirrorCommit: previous.manifest.source.commit },
    policyChanged,
    disclosure: disclosureDelta(previous.manifest, planned.manifest),
    changes: planned.changes,
  };
}
