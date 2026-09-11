# Security policy

GHOSTBOUND is a small disclosure boundary, not a sandbox or a proof of secrecy.
Read [the threat model](docs/THREAT_MODEL.md) before use. Only the current v0.1
release line is in scope for fixes at present.

Report vulnerabilities using GitHub's private vulnerability reporting on this
repository if available. Do not put private source, actual credentials, or
sensitive workspace paths in public issues. If private reporting is unavailable,
open an issue asking for a private reporting channel without exploit details
or sensitive data. Use a minimal synthetic repository for reproduction.

Useful reports identify the affected version/platform, intended policy,
synthetic input and observed boundary violation. There is no promised response
SLA. Findings affecting path confinement, snapshot isolation, secret-gate
bypass, output ownership or unsafe replacement take priority.
