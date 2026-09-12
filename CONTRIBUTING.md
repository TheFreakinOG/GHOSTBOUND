# Contributing to GHOSTBOUND

Thanks for helping improve GHOSTBOUND. v0.1 is intentionally narrow: it is a small, auditable Git-native disclosure boundary, not a general repository-processing framework.

Before contributing, please read:

- [README.md](README.md) for the product scope and usage
- [SECURITY.md](SECURITY.md) for vulnerability reporting
- [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) for the security boundary and limitations
- [docs/DESIGN.md](docs/DESIGN.md) for the implementation model and invariants

## Scope

Keep changes focused on the existing v0.1 contract. Avoid unrelated refactors, new dependencies, speculative abstractions, and feature expansion. Changes to runtime or security behavior should be justified by a concrete bug or boundary issue and kept as small as practical.

## Development requirements

GHOSTBOUND requires Node.js 22 or newer, a current Git with `--no-lazy-fetch` support, and upstream Gitleaks CLI 8.30.x or newer within major version 8 on `PATH`. On Windows, `whoami.exe` and `icacls.exe` are also required. The project has no runtime npm dependencies.

Before submitting a change, run:

```sh
npm run check
npm test
npm pack --dry-run
```

Use only synthetic repositories, synthetic credentials, and non-sensitive paths in tests and reproductions. Never include real secrets, private repository contents, or sensitive local filesystem paths in issues, test fixtures, logs, or patches.

Security vulnerabilities must not be reported in a public issue. Follow [SECURITY.md](SECURITY.md) instead.
