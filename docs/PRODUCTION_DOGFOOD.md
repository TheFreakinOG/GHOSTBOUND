# Production dogfood and cutover evidence

GHOSTBOUND was built around a real operational need: move an explicitly approved, committed view of a private Git workspace across a trust boundary without giving the recipient the full source repository.

Before GHOSTBOUND, that workflow used a private one-off exporter. GHOSTBOUND v0.2 now runs the production publication path that originally motivated the project.

## Production path

```text
private Git workspace
      ↓
GHOSTBOUND View
      ↓
verified local mirror
      ↓
verified Git publish
      ↓
remote consumer
```

The local-mirror path remains first-class. Git publication is optional delivery; it does not replace the local trust-boundary workflow.

## Evidence from the real cutover

The production migration completed with:

- real end-to-end dogfood on the original workflow
- shadow-production updates before cutover
- verified local materialization and provenance
- verified Git publication
- independent post-cutover review
- remote-consumer verification against the published result
- Gitleaks PASS
- no force-push migration path
- the previous one-off exporter removed from the normal production path and retained only as a manually invoked recovery/rollback fallback

No reproducible GHOSTBOUND core defect was found during this migration.

## What this evidence means

This is not a synthetic benchmark and it is not a claim that GHOSTBOUND fits every repository or every disclosure model. It demonstrates that the current v0.2 contract is sufficient for the real workflow that created the project.

It also validates the intended product boundary:

> control which committed information crosses a trust boundary and make that handoff verifiable

GHOSTBOUND does not decide how little context a recipient should receive. The operator chooses the disclosure surface. GHOSTBOUND makes that choice explicit, reproducible and independently checkable.

## What this does not claim

The cutover does not prove that every secret will be detected, that every future workflow will fit the current policy model, or that Git publication is required for GHOSTBOUND to be useful.

The project remains intentionally narrow and fail-closed. New product work should be driven by reproducible bugs or real external usage rather than speculative feature expansion.
