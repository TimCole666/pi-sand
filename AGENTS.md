## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Domain docs

This is a single-context repo. Read root-level `CONTEXT.md` when present and the relevant ADRs under `docs/adr/`. See `docs/agents/domain.md`.

### Reuse-first architecture

Before designing or implementing post-v0.4 runtime capabilities, read:

- `docs/adr/0001-reuse-first-runtime-boundary.md`
- `docs/architecture/reuse-ledger.md`
- `docs/roadmap.md`

For the in-progress v0.4 release, Issue #48 remains the architecture/spec authority. For current implementation facts, current source/tests and the actual PR #62 implementation are authoritative. Do not use these future-facing reuse documents to reopen v0.4, refactor working v0.4 mechanics, or resolve a #48↔implementation discrepancy; handle that inside the v0.4 issue/PR process.

Before building nontrivial post-v0.4 mechanics, follow the reuse hierarchy in the ADR and ask: what exact pi-sand-specific responsibility, authority, identity, recovery, or product invariant requires custom ownership?

Own semantics; reuse mechanics and infrastructure. Reused components return observations or receipts, not pi-sand domain decisions. Do not add a second Agent Engine beside Pi.
