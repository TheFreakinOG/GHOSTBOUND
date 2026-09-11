# GHOSTBOUND

A Git-native trust boundary that gives humans and AI agents a verifiable least-privilege view of a private workspace.

**GHOSTBOUND controls what another trust domain is allowed to see.**

```text
immutable Git snapshot → explicit policy → security gates → real-file mirror → verifiable provenance
```

GHOSTBOUND v0.1 exports explicitly selected text files from one local Git commit.
It produces ordinary files, an exact policy snapshot, and a deterministic manifest.
Dirty, deleted and untracked working-tree files never supply export bytes.

## Quick start

Prerequisites: Node.js 22 or newer, a current Git with `--no-lazy-fetch`
support, and upstream [Gitleaks CLI](https://github.com/gitleaks/gitleaks/releases)
8.30.x or newer within major version 8 on PATH. CI pins Gitleaks 8.30.1.
On Windows, `whoami.exe` and `icacls.exe` must be available to restrict staging ACLs.
GHOSTBOUND respects Git `safe.directory`; resolve repository ownership yourself.

From this checkout (no npm install or runtime npm dependencies required):

```sh
node src/cli.mjs --help
node src/cli.mjs plan --repo /private/repository --commit FULL_COMMIT_OID --policy /private/policy.json --out /private/share/mirror
node src/cli.mjs materialize --repo /private/repository --commit FULL_COMMIT_OID --policy /private/policy.json --out /private/share/mirror
node src/cli.mjs verify --out /private/share/mirror
```

Replace `FULL_COMMIT_OID` with an already resolved, full lowercase SHA-1 or
SHA-256 commit OID. `HEAD`, tags, branch names, revspecs and abbreviated OIDs
are rejected. The local repository must already contain every required object.
GHOSTBOUND never clones, fetches, pulls, pushes or resolves remote branches.
Older Git versions without the no-lazy-fetch flag fail closed.

For a local package installation, run `npm pack`, then install the resulting
tarball using `npm install --global ./ghostbound-0.1.0.tgz`. The binary is
`ghostbound`; replace `node src/cli.mjs` above with that name. This repository
does not imply an npm registry release or reservation of the package name.

The output's parent must already exist and be trusted. Output and source must
be disjoint. The output must be absent, empty, or a fully verified GHOSTBOUND
mirror. All its contents belong to GHOSTBOUND. Do not put `.git`, notes, or
other files inside it. Extra files, empty extra directories, missing files,
tampering and links block updates. There is no force or repair mode.

## Policy

```json
{
  "schema": "ghostbound.policy/v1",
  "include": [
    { "path": "README.md" },
    { "tree": "src", "to": "source" },
    { "path": "docs/architecture.md", "to": "ARCHITECTURE.md" }
  ]
}
```

`path` selects exactly one file. `tree` selects every entry below a directory
prefix. Without `to`, the relative source path is retained. Missing selections,
overlapping source rules and ambiguous destinations block the entire operation.
Unknown keys, duplicate JSON keys and type errors also block it. There are no
globs, exclusions, inherited ignore files, environment expansions or scripts.

Optional `limits` can only lower these ceilings: `maxFiles: 10000`,
`maxFileBytes: 4194304`, `maxTotalBytes: 67108864`. Policy JSON is limited to
1 MiB. See [policy schema](schemas/policy.schema.json) and [design](docs/DESIGN.md).

`plan` runs the same gates as `materialize`, including the mandatory secret
scan and complete staging verification, then reports sorted `create`, `update`
and `delete` paths (including metadata). It never mutates the final output.
It does create and remove private sibling staging. `materialize` swaps in the
verified staging directory, verifies the final mirror and removes the old backup.

## Integrity and provenance

`.ghostbound/manifest.json` records tool version, source object format,
commit/tree, source-to-destination mapping, native blob OIDs, Git modes, byte
lengths, SHA-256 hashes, policy digest and scanner version/config digest.
`.ghostbound/policy.json` contains the **exact input policy bytes**.
The [manifest schema](schemas/manifest.schema.json) documents its structure.

The mirror digest is SHA-256 of UTF-8 `JSON.stringify` of an array of
`[destination, gitMode, sha256]` tuples, sorted by destination using JavaScript
string comparison, with no added whitespace or newline. All filenames must be
NFC. Manifest JSON uses two-space indentation and one final LF.

**Mirror integrity verification** needs only the mirror:

```sh
ghostbound verify --out /private/share/mirror
```

It validates metadata, policy digest and mapping consistency, paths, regular
file types, exact inventory, sizes, content hashes, blob hashes, aggregate
digest and executable bits on POSIX. It does not rerun Gitleaks.

**Source provenance verification** additionally needs all three source inputs:

```sh
ghostbound verify --out /private/share/mirror --repo /private/repository --commit FULL_COMMIT_OID --policy /private/policy.json
```

It recomputes the selected snapshot and compares commit, tree, policy bytes,
source paths, modes, blob OIDs, mapping and content hashes. This detects
missing policy-selected files that cannot be inferred from a standalone mirror.

These hashes are provenance evidence, **not signatures or identity attestations**.
A dishonest producer can forge a self-consistent mirror and manifest. Use a
trusted source OID and policy for source verification. There is no Sigstore,
SLSA claim or external signing trust anchor in v0.1.

## Secret gate

Gitleaks is an external runtime prerequisite, not a bundled scanner or GitHub
Action. Missing scanner, unsupported version, errors, timeout, malformed report
or findings block materialization. There is no disable flag.

The bundled config extends upstream default rules. A separate private scan
directory uses neutral `.txt` filenames and includes source/destination names
and the policy bytes. Source `.gitleaks.toml`, `.gitleaksignore`, ambient
`GITLEAKS_*` settings and `gitleaks:allow` comments cannot disable the gate.
Scanner stdout/stderr are never forwarded; redacted JSON stays in process
memory and never enters the mirror. Errors intentionally omit finding details.

The access boundary comes from **immutable snapshot + explicit policy +
path/type confinement**. Secret detection is heuristic defense in depth and
cannot prove complete freedom from secrets. Review the allowlist yourself.
Neutral scan filenames also mean upstream filename-specific rules are not a
guarantee. See [THIRD_PARTY.md](THIRD_PARTY.md).

## Threat model and limitations

Only regular Git blobs (`100644`, `100755`) containing valid UTF-8 text are
supported. Control/binary content, NUL, LFS pointers, selected symlinks and
submodules block the operation. Executable metadata is preserved; Windows does
not enforce POSIX execute bits. File mtimes and host ACLs are not provenance.

Destination paths reject traversal, absolute paths, Windows ambiguities,
reserved device names, non-NFC Unicode, case collisions, `.ghostbound` and
`.git` components. Mirror files cannot be symlinks, junctions or hardlinks.
Output ancestors are checked with `lstat` and `realpath`.

Staging is owner-only (POSIX permissions or Windows ACLs). Run under an account
that can read the selected private source. Keep staging and output parents
private until publication by your own separate workflow. A rename failure
attempts rollback; crashes between renames can leave an absent final directory
and a sibling staging directory containing the backup. No crash-recovery daemon
or durability guarantee is provided. See [DESIGN.md](docs/DESIGN.md).

GHOSTBOUND is not an OS sandbox against a concurrently mutating local attacker
with the same permissions. It does not protect against compromised Git, Node,
Gitleaks, the installed tool itself, or intentionally allowlisted sensitive
information that lacks a detectable secret signature.
Read the full [threat model](docs/THREAT_MODEL.md) and [security policy](SECURITY.md).

## Non-goals and neighboring tools

GHOSTBOUND is not a prompt packer, RAG/memory system, semantic selector, sandbox,
agent runner, orchestrator, model adapter, publisher, remote downloader,
background sync, watcher or history sanitizer. It has no plugins, policy
inheritance, binaries, LFS smudge, submodule traversal or agent write-back.

[Repomix](https://github.com/yamadashy/repomix) and
[Code2Prompt](https://github.com/mufeedvh/code2prompt) can consume an already
verified mirror. GHOSTBOUND controls disclosure; it does not replace their
prompt-packing features. Signatures and other integrations are outside v0.1.

## Development

```sh
npm run check
npm test
npm pack --dry-run
```

Tests use synthetic repositories only. Install Gitleaks for the real end-to-end
tests; `GHOSTBOUND_REQUIRE_GITLEAKS=1` makes a missing scanner fail the suite
instead of skipping those tests. CI requires it on Linux and Windows with
Node 22 and 24. Process fakes cover scanner failure cases only.

Licensed under [Apache-2.0](LICENSE).
