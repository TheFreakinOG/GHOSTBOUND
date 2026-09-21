# GHOSTBOUND

**GHOSTBOUND creates verifiable, policy-controlled Views of private Git workspaces and safely hands them across trust boundaries.**

Share exactly the files you approve from one immutable Git commit — as ordinary files with verifiable provenance — without exposing the rest of the repository or leaking dirty working-tree state.

```text
private Git workspace
        │
        ▼
 immutable commit
        │
        ▼
 explicit allowlist
        │
        ▼
 security gates
        │
        ▼
 verified real-file mirror
```

GHOSTBOUND controls **what crosses into another trust domain**.

That other side might be an AI coding agent, a planner, an external reviewer, a sandbox, or simply another human who should not receive your entire private repository.

## Why GHOSTBOUND?

Giving a tool access to a private repository is often an all-or-nothing decision.

Manually copying files is difficult to reproduce. Ignore files are not disclosure policies. Working trees may contain dirty, deleted or untracked data. Prompt-packing tools solve a different problem: how to package context after you have decided what may be disclosed.

GHOSTBOUND puts an explicit boundary before that step.

Given:

```text
repository + exact commit + explicit policy
```

it creates a separate real-file mirror containing only the selected committed files.

The mirror can then be given to another tool or person without giving them access to the original repository.

## Production proof: it replaced the workflow that created it

GHOSTBOUND started from a real private-workspace publication problem: a controlled review surface had to cross into another trust domain without turning the entire source repository into the handoff. The original solution was a private one-off exporter.

That production workflow now runs through GHOSTBOUND v0.2:

```text
private workspace
      ↓
GHOSTBOUND View
      ↓
verified local mirror
      ↓
verified Git publish
      ↓
remote consumer
```

The cutover passed real dogfood, shadow-production updates, independent review, remote-consumer verification and a Gitleaks scan. The old exporter is now only a manually invoked recovery/rollback fallback.

That is the strongest evidence for the current release: **GHOSTBOUND now runs the production workflow that originally motivated the project, replacing its private one-off exporter.**

See [production dogfood and cutover evidence](docs/PRODUCTION_DOGFOOD.md).

## What v0.2 guarantees

| Property                     | How GHOSTBOUND enforces it                                                                                        |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Immutable source             | Export bytes come from blob objects belonging to one exact Git commit                                             |
| Explicit disclosure          | Only policy-selected files or trees are included                                                                  |
| No dirty-tree leakage        | Dirty, deleted and untracked working-tree files never provide export bytes                                        |
| Real isolation               | The result is a separate directory of ordinary files, not a filtered view into the source repository              |
| Path confinement             | Traversal, absolute paths, unsafe Windows names, Unicode/case collisions and reserved paths are rejected          |
| Link safety                  | Selected symlinks and submodules are rejected; mirror links and unsafe ancestors block verification               |
| Secret defense in depth      | A mandatory Gitleaks scan runs before materialization                                                             |
| Safe updates                 | Existing mirrors are verified before managed replacement and stale files are removed                              |
| Provenance                   | The mirror contains the exact policy and a deterministic manifest with source mappings, hashes and Git object IDs |
| Independent integrity checks | `ghostbound verify` can validate a mirror without access to the private source                                    |
| Reusable Views              | A strict JSON View binds a source, policy, output and optional publication target                              |
| Status and disclosure delta | Local status distinguishes current, stale, invalid and unverifiable mirrors                                  |
| Optional Git publication    | A previously verified mirror can be published with exact tree, race and ownership checks                      |

GHOSTBOUND is intentionally fail-closed. Unsupported or ambiguous input blocks the operation rather than silently weakening the boundary.

## What GHOSTBOUND is not

GHOSTBOUND is **not** a sandbox, prompt packer, RAG system, AI agent, orchestrator, repository sanitizer, GitHub App or background sync service. Its optional publisher is a narrow verified Git delivery path, not a general repository-publishing framework.

It does not claim that a mirror is free of every possible secret. Secret scanning is heuristic defense in depth.

It also does not authenticate the identity of whoever produced a mirror. Hashes prove consistency, not authorship. Source provenance becomes meaningful when the verifier independently trusts the source commit and policy.

See the full [threat model](docs/THREAT_MODEL.md).

## Quick start

### Requirements

GHOSTBOUND v0.2 requires:

* Node.js 22 or newer
* a current Git with `--no-lazy-fetch` support
* upstream Gitleaks CLI 8.30.x or newer within major version 8 on `PATH`
* on Windows, `whoami.exe` and `icacls.exe`

GHOSTBOUND itself has no runtime npm dependencies.

Clone the repository:

```sh
git clone https://github.com/TheFreakinOG/GHOSTBOUND.git
cd GHOSTBOUND
```

Check the CLI:

```sh
node src/cli.mjs --help
```

### 1. Create a policy

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

`path` selects one file.

`tree` selects every entry below a directory prefix.

`to` optionally changes the destination path.

There are deliberately no globs, exclusions, inherited ignore files, environment expansions or executable policy hooks.

See [examples/ghostbound.policy.json](examples/ghostbound.policy.json) and the [policy schema](schemas/policy.schema.json).

### 2. Choose one immutable commit

GHOSTBOUND accepts only a full lowercase SHA-1 or SHA-256 commit OID.

Resolve it yourself before invoking GHOSTBOUND:

```sh
git -C /private/repository rev-parse HEAD
```

Branch names, tags, abbreviated hashes and revspecs are not accepted by the snapshot core. View `HEAD` resolution is a local, network-free convenience that produces one full commit OID before the core runs.

`plan`, `materialize`, `verify`, `status` and View `HEAD` resolution do not use the network. Only explicit `publish --view` performs remote reads and a normal Git push.

### 3. Plan the mirror

```sh
node src/cli.mjs plan \
  --repo /private/repository \
  --commit FULL_COMMIT_OID \
  --policy /private/policy.json \
  --out /private/share/mirror
```

`plan` runs the same validation and secret gates as materialization, including staging verification, but does not replace the final output.

It reports the sorted files that would be created, updated or deleted.

### 4. Materialize

```sh
node src/cli.mjs materialize \
  --repo /private/repository \
  --commit FULL_COMMIT_OID \
  --policy /private/policy.json \
  --out /private/share/mirror
```

The result is an ordinary directory containing the approved files plus:

```text
.ghostbound/
├── manifest.json
└── policy.json
```

The output belongs entirely to GHOSTBOUND. Do not place unrelated files, `.git`, notes or other content inside a managed mirror.

### 5. Verify

A receiver can validate mirror integrity without access to the private repository:

```sh
node src/cli.mjs verify --out /private/share/mirror
```

For full source provenance verification:

```sh
node src/cli.mjs verify \
  --out /private/share/mirror \
  --repo /private/repository \
  --commit FULL_COMMIT_OID \
  --policy /private/policy.json
```

Standalone verification proves that the mirror is internally consistent with its manifest and captured policy.

Source verification additionally recomputes the selected Git snapshot and checks that the mirror actually corresponds to the trusted commit and policy.

### Reusable Views

A View is operator configuration, not a new disclosure primitive:

```json
{
  "schema": "ghostbound.view/v1",
  "name": "chatgpt",
  "source": { "repo": "../private-workspace", "ref": "HEAD" },
  "policy": "./chatgpt.policy.json",
  "out": "../mirrors/chatgpt"
}
```

View paths resolve relative to the View file; absolute paths are also allowed. `source.ref` is exactly `HEAD` or a full SHA-1/SHA-256 OID. Unknown keys, duplicate JSON keys, symlink Views and unsafe names are rejected. See [the View schema](schemas/view.schema.json) and [the example](examples/ghostbound.view.json).

Use the View workflow with:

```sh
node src/cli.mjs plan --view ./chatgpt.view.json
node src/cli.mjs materialize --view ./chatgpt.view.json
node src/cli.mjs verify --view ./chatgpt.view.json
node src/cli.mjs status --view ./chatgpt.view.json
```

`status` reports `CURRENT`, `STALE`, `INVALID` or `UNVERIFIABLE`. A source commit change is still `STALE` when no approved content changed; its disclosure delta is empty because provenance is nevertheless old. Disclosure deltas use `newlyExposed`, `changedExposed` and `noLongerExposed`, while filesystem changes continue to use `create`, `update` and `delete`.

### Optional verified Git publication

Add an explicit `publish` object to a View, then run:

```sh
node src/cli.mjs publish --view ./chatgpt.view.json
```

The sequence is always:

```text
private repo → GHOSTBOUND → verified local mirror → verified Git publish → remote consumer
```

Publication validates the mirror standalone and against the resolved source commit and policy before any network write. It creates the publication tree from mirror bytes with an isolated temporary index and Git plumbing; target working-tree files, the real target index, filters and unrelated files are never publication input. The tree contains exactly the mirror files plus `.ghostbound/manifest.json` and `.ghostbound/policy.json`.

The View's remote URL must exactly match the configured fetch and push URL. The target branch must match the configured branch and be clean. Initial publication requires an absent remote branch, an unborn local branch and no prior local GHOSTBOUND state; existing remote branches are never adopted. Later publications use `refs/ghostbound/views/<name>` as the confirmed local state, require the remote tip to match it, recheck it immediately before push, use a normal non-rewriting refspec, confirm the resulting remote SHA, and only then update that local ref. Git credentials remain the responsibility of Git, credential helpers, SSH or HTTPS; GHOSTBOUND does not manage credentials or claim identity attestation.

## Why not `.gitignore`, sparse checkout or Repomix?

They solve different problems.

`.gitignore` controls what Git normally tracks. It is not a disclosure boundary for already committed content.

Sparse checkout controls what appears in a Git working tree. The recipient still operates within Git repository semantics and it is not designed to produce a provenance-carrying disclosure artifact.

Tools such as [Repomix](https://github.com/yamadashy/repomix) and [Code2Prompt](https://github.com/mufeedvh/code2prompt) are useful for packaging code into model-friendly context.

GHOSTBOUND sits **before** them:

```text
private repository
      ↓
  GHOSTBOUND
      ↓
verified least-privilege mirror
      ↓
Repomix / Code2Prompt / AI agent / reviewer / sandbox
```

GHOSTBOUND decides what may cross the trust boundary. Other tools can decide what to do with the already-approved mirror.

## Security model

The protected asset is everything in the private workspace outside the explicitly authorized view.

The core disclosure boundary is:

```text
immutable Git snapshot
+ explicit policy
+ path/type confinement
```

Mandatory Gitleaks scanning adds defense in depth.

Selected content must be regular Git blobs containing valid UTF-8 text. Binary content, NUL/control content, Git LFS pointers, symlinks, submodules and unsupported Git modes block the operation.

Destination validation rejects traversal, absolute paths, Windows path ambiguities, reserved device names, non-NFC Unicode, case collisions, `.git` and `.ghostbound`.

Mirrors are verified using exact inventory, byte lengths, content hashes, Git modes, policy integrity and aggregate digest information.

For the complete boundary and its limitations, read:

* [Threat model](docs/THREAT_MODEL.md)
* [Design](docs/DESIGN.md)
* [Security policy](SECURITY.md)

### Important limitations

GHOSTBOUND does not protect against compromised installations of GHOSTBOUND, Node, Git or Gitleaks.

It is not an OS sandbox against another process running with equivalent local permissions.

Secret scanners can miss secrets.

Authorized source text may itself contain malicious instructions or prompt injection; GHOSTBOUND controls disclosure, not the semantics of approved content.

Manifest hashes are provenance evidence, not signatures or identity attestations.

Concurrent writers to the same output remain unsupported. Publication additionally fails closed on target, local-state or remote races.

## Determinism and provenance

`.ghostbound/manifest.json` records the tool version, source object format, commit and tree, source-to-destination mapping, native blob OIDs, Git modes, byte lengths, SHA-256 hashes, policy digest and scanner information.

`.ghostbound/policy.json` contains the exact input policy bytes.

Given the same local Git objects, commit, exact policy bytes, GHOSTBOUND version and scanner version/configuration, the logical mirror is deterministic.

See the [manifest schema](schemas/manifest.schema.json) for the complete format.

## Conservative by design

GHOSTBOUND v0.2 intentionally keeps the v0.1 security core narrow.

It does not have plugins, policy inheritance, executable policy logic, binary export, submodule traversal, LFS smudge, agent write-back, automatic materialize-on-publish, adoption of existing remote branches, watching or background synchronization. A policy may intentionally disclose 5%, 80% or practically all suitable files; GHOSTBOUND does not decide semantically how much context a consumer needs. Different consumers get the context you intentionally approved for them.

Those omissions keep the trust boundary small enough to reason about.

## Development

```sh
npm run check
npm test
npm pack --dry-run
```

The test suite uses synthetic repositories.

Install Gitleaks for the real end-to-end tests. Setting:

```sh
GHOSTBOUND_REQUIRE_GITLEAKS=1
```

makes a missing scanner fail the suite rather than skip integration tests.

CI runs on Linux and Windows using Node.js 22 and 24.

## Security reports

Please read [SECURITY.md](SECURITY.md) before reporting vulnerabilities.

Do not include real credentials, private repository content or sensitive workspace paths in public issues. Use a minimal synthetic reproduction.

## License

Apache-2.0.
