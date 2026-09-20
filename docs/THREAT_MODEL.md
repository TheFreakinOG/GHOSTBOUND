# Threat model

## Assets and trust

The protected asset is private workspace content outside the explicitly
authorized view. The operator trusts the installed GHOSTBOUND code, Node, Git,
Gitleaks and their local executable/configuration environment, and chooses a
local repository, immutable commit and audited policy. The receiving human or
agent gets only the mirror. Git history and unselected blobs are not exported.
The operator controls the output parent and does not run concurrent writers.

## Threats addressed

| Threat | Boundary or gate |
| --- | --- |
| Accidental broad disclosure | Explicit file/tree rules; no implicit defaults, globs or inherited policy |
| Dirty/untracked working-tree leakage | Selected bytes are read from commit-selected blob OIDs |
| Traversal or absolute escape | Central relative path validation and disjoint root checks |
| Windows path ambiguity | Drive/UNC/backslash/invalid-character/device/trailing-dot-space rejection |
| Unicode/case/file-directory collisions | NFC requirement, case folding and prefix conflict checks |
| Symlink/junction escape | Selected Git symlinks blocked; output ancestors and inventory inspected with lstat/realpath |
| Submodule disclosure | Selected Gitlinks block, never traverse or download |
| Stale file retention | Complete mirror replacement; old files disappear only after verified ownership |
| Unsafe update/deletion | Foreign roots block; old mirror and backup verified before replacement/deletion |
| Tampered mirror | Exact file/directory inventory, hashes, modes, lengths, policy and metadata validation |
| Common detectable secrets | Mandatory external default-rule Gitleaks scan; finding/error blocks |
| Scanner suppression | Explicit shipped config, neutral scan names, clean environment, allow-comments ignored |
| Argument/ref injection | No shell; closed CLI; full hex OIDs; blob reads by native OID |
| Resource abuse | Bounded sizes, counts, paths, JSON depth and subprocess time/output |

## Not protected

GHOSTBOUND does not protect against compromised Node, Git, Gitleaks or
GHOSTBOUND installations; a concurrent attacker with equivalent OS rights;
secrets the heuristic scanner misses; intentionally allowlisted sensitive data
without recognizable secret signatures; or OS sandbox escape. It is not a
sandbox. Trusted local Git configuration/object storage is not an isolation
boundary against malicious executable tools or filesystem administrators.

The access boundary is immutable snapshot + explicit policy + path/type
confinement. Secret detection is defense in depth and cannot prove complete
secrecy. Neutral scanner filenames reduce source-controlled suppression but
do not retain filename-specific detection semantics. Encoded or obfuscated
secrets and upstream rule allowlists can cause false negatives.

Hashes do not authenticate identity. A producer can rewrite content and all
metadata into another self-consistent mirror. No digital signature, identity
attestation, Sigstore/SLSA statement or external trust anchor is provided.
Trust a separately reviewed policy and source OID for source verification.

## Data and operational limits

Text only: valid UTF-8 with no NUL/disallowed control bytes, no LFS pointers,
no binary assets, symlinks, submodules or special entries. Committed executable
files are copied but never executed by GHOSTBOUND. The consumer must decide
whether executing mirror code or following agent instructions is appropriate;
GHOSTBOUND does not neutralize prompt injection inside authorized text.

Policy and selected relative source names are intentionally disclosed as
provenance. Do not include sensitive names in an authorized policy. Native
errors and scanner diagnostics are suppressed in CLI output. Process args
necessarily contain local repo/policy/output locations and may be observable
to privileged local process inspectors.

POSIX staging is mode 0700; Windows staging receives an owner SID ACL before
writing content. Parent directories must be trusted. Successful mirrors retain
restrictive access; sharing/publication is a separate operator action. No
network operation or publishing machinery exists in the core.

Rename rollback is best effort, not crash-atomic or durable. A crash or failed
rollback may leave the prior mirror in a sibling staging directory. The tool
retains recovery material if rollback cannot complete. See [DESIGN.md](DESIGN.md).
Same-user TOCTOU races and concurrent writers are explicitly out of scope.

## v0.2 Views and publication

A View is untrusted operator configuration validated by strict JSON parsing,
portable identifiers, safe paths and a narrow source reference. `HEAD` is
resolved locally and network-free to a complete commit before the v0.1 core
runs. Status uses standalone verification first: a nonempty invalid mirror is
`INVALID`, while absent or empty output is `UNVERIFIABLE`; source, policy and
security-gate errors still block normally.

Publication adds trust in the locally installed Git and its configured
remote-transport and credential infrastructure, plus the remote server as a
place that stores the confirmed Git object. GHOSTBOUND does not manage
credentials and does not replace TLS or SSH authentication. The remote SHA
proves that the configured remote ref points to the same commit whose tree was
checked locally against the verified mirror. It does not prove human identity,
commit signatures, remote-server integrity or secrecy beyond the existing
Gitleaks defense.

Publication creates a complete tree only from verified mirror bytes, verifies
the target tree before commit, rejects unmanaged content, and keeps the target
working tree and real index out of the construction path. A local
`refs/ghostbound/views/<name>` records only a confirmed remote tip. Initial
publication requires an absent remote branch and an unborn local branch;
existing remote branches are not adopted. Later publication checks the local
state ref and remote tip before and immediately before the push, then confirms
the resulting remote SHA before updating local state. No digital attestation is
claimed.
