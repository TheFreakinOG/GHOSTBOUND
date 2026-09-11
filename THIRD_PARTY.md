# Third-party components

GHOSTBOUND has no runtime npm dependencies and embeds no third-party scanner
source code. It is licensed under Apache-2.0.

| Component | Use | License / source |
| --- | --- | --- |
| Gitleaks CLI | Required external runtime secret scanner; CI pins 8.30.1 | [MIT, upstream LICENSE](https://github.com/gitleaks/gitleaks/blob/v8.30.1/LICENSE) |
| Git | External local object database/plumbing executable | [GPL-2.0, upstream COPYING](https://github.com/git/git/blob/master/COPYING) |
| Node.js | External JavaScript runtime | [Node.js license and bundled notices](https://github.com/nodejs/node/blob/main/LICENSE) |
| actions/checkout | CI checkout only | [MIT](https://github.com/actions/checkout/blob/main/LICENSE) |
| actions/setup-node | CI runtime setup only | [MIT](https://github.com/actions/setup-node/blob/main/LICENSE) |

The upstream Gitleaks CLI license was checked before integration. The separate
`gitleaks-action` is neither used nor required. Gitleaks is installed separately;
its binary is not included in the npm package. The shipped TOML only requests
extension of the installed upstream defaults; it does not copy rule source.
The scanner version and shipped config digest are recorded in each manifest.

CI downloads pinned upstream release archives and checks literal SHA-256 values
before extraction. These hashes protect against accidental/mismatched artifacts;
they are not an independent publisher identity attestation. Review updates.

Repomix and Code2Prompt are interoperability references only; no source from
either project is copied or bundled. A pre-existing private publication tool
informed the snapshot/allowlist/manifest design; no private code, fixtures,
workspace configuration or data is included here.
