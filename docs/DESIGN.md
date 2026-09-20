# GHOSTBOUND v0.2 design

## Small trust boundary

`cli.mjs` accepts plan/materialize/verify/status/publish and a closed set of flags.
`git.mjs` validates the repository root and object format, rejects non-full
commit OIDs, enumerates one recursive NUL-delimited tree and reads only selected
blob OIDs. `policy.mjs` validates strict JSON and performs explicit selection.
`paths.mjs` provides portable path validation, collision and root confinement.
`secrets.mjs` invokes the required upstream scanner on private scan copies.
`manifest.mjs` validates complete mirror ownership and integrity.
`mirror.mjs` stages, verifies, computes changes and replaces transactionally.
`common.mjs` holds bounded JSON parsing, UTF-8 validation and digest helpers.

There are no runtime npm dependencies, shell-built commands or plugins. Core
Git subprocesses receive argv arrays, a sanitized environment, disabled replace
objects and lazy fetch, a protocol deny default, deadlines and output limits.
The core, View resolution and status remain network-free. Only `publish.mjs`
contains remote reads and pushes. Git repository configuration and the
executables remain trusted local inputs; ownership checks are not bypassed. No
working-tree files provide export bytes. A policy is an explicit separate
input, captured byte-for-byte.

Raw tree-path buffers are compared only to locate the policy candidate scope.
Candidate paths must then decode as valid UTF-8 and pass NFC/portable validation
before destination mapping. Malformed paths outside the selected scope do not
cause unrelated bytes to be read. Selected unsupported modes block, including
gitlinks which `ls-tree -r` does not traverse.

## Fixed resource ceilings

Selected files: 10,000; each file: 4 MiB; total: 64 MiB; policy: 1 MiB;
manifest: 16 MiB; tree output: 32 MiB and 200,000 entries; JSON depth: 32;
relative path: 1,024 UTF-8 bytes, at most 32 segments, each at most 240 bytes.
Git subprocesses time out after 30 seconds. Each scanner invocation has a
120-second process timeout; scanning additionally uses a 110-second deadline.
Scanner stdout/stderr buffers are each bounded to 4 MiB. Limits block rather
than silently truncating or skipping selected files. Policy limits only lower
file count/per-file/total ceilings. Total runtime can still grow with file count;
this is not an adversarial computation sandbox.

## Determinism

Given the same local Git objects, commit, exact policy bytes, tool version and
Gitleaks version/config, the logical mirror is byte-identical. Sorting uses
JavaScript UTF-16 string comparison, never locale-dependent collation. The
aggregate digest is defined in the README. No current time, absolute local
path, remote, username or hostname is written to metadata. Different policy
whitespace intentionally yields a different policy digest. POSIX executable bits
are checked; mtime, ACL representation, ownership and other OS metadata are not
part of the digest. Metadata itself is included in plan changes, not recursively
included in the content aggregate.

## Transaction

1. Validate snapshot, policy, paths and existing output ownership.
2. Create a private sibling `.ghostbound-stage-*` directory; populate its
   `mirror` child. Scan neutral copies of selected bytes and policy, write
   metadata and fully verify the staged mirror.
3. Reverify the existing output against the initial observation. Rename it to
   `previous` inside the private staging directory, then rename the staged
   mirror to the final output name.
4. Verify the final mirror. On failure move it back and restore `previous`.
   Reverify the backup before removing the transaction directory.

No old-output mutation occurs before all gates pass. Sibling staging ensures
same-filesystem rename. Windows open handles may prevent rename; errors attempt
rollback. If rollback fails, the transaction directory is retained for manual
recovery. If cleanup fails after successful installation, the command fails
and the valid output can coexist with a retained backup. Never automatically
delete a retained backup: inspect it and verify either candidate first.

There is no atomic exchange of two directories, fsync durability protocol or
crash recovery. A crash after moving the old mirror can leave the final path
absent, with its prior bytes in `.ghostbound-stage-*/previous`. Concurrent
invocations and same-user races are unsupported. Run one operation per output
at a time. Root and child checks reduce accidental escapes but are not a
race-proof descriptor-relative filesystem sandbox.

## Deliberate conservative decisions

Source paths must also satisfy portable path syntax. `.git` components are
blocked to prevent a mirror from becoming an attacker-defined Git repository;
`.ghostbound` is reserved at every destination depth. Extra empty directories
and hardlinks block ownership validation. Gitleaks scan filenames are neutral
to avoid source ignore/config effects and default extension exclusions; all
selected content is still validated and materialized at its real mapped path.
Policy bytes and relative source/destination names are scanned because they
also appear in released provenance. Findings are reported as a generic block
instead of risking content leakage through scanner diagnostics.

Public manifest metadata is unsigned. Standalone verification proves only
internal consistency against the manifest and its policy, not completeness
against an unseen tree or honesty of its producer. Source verification supplies
that missing comparison, provided the caller trusts the commit and policy.

## v0.2 View, status and publication

`view.mjs` is a strict operator-configuration layer. It resolves paths relative
to the View file, accepts only `HEAD` or a complete OID, and resolves `HEAD`
locally to one complete commit before calling the snapshot core. It adds no
disclosure primitive and does not accept branches, tags or general revspecs.

`delta.mjs` is the single record-diff primitive. Filesystem changes compare
destination bytes and modes; disclosure changes compare source, destination,
Git blob OID, Git mode, length and SHA-256 provenance. This permits a source
commit-only change to be reported as stale with an empty disclosure delta.

`status.mjs` first validates a nonempty mirror standalone. A failed standalone
check is `INVALID`; absent or empty output is `UNVERIFIABLE`. For valid or
absent output, status computes the current local plan and reports `CURRENT` or
`STALE`. Policy and source/security errors propagate and are not relabeled.

`publish.mjs` is the only network-capable layer. It verifies the local mirror
standalone and against the View source and policy, then constructs a target
tree from mirror bytes with `hash-object`, an isolated temporary index,
`update-index --index-info`, and `write-tree`. It never discovers or stages the
target working tree. The target tree is re-read and checked by bytes, lengths,
modes and hashes before `commit-tree`. Publication state is a local
`refs/ghostbound/views/<name>` ref updated only after remote SHA confirmation.
The ref and remote tip are compared before and immediately before a normal
push; races block closed. No existing remote branch is adopted automatically.
