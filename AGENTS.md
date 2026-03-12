# PatchRelay Agent Notes

PatchRelay is a harness around Codex and Linear. Keep changes aligned with the current harness
boundaries and avoid pulling repo-specific workflow policy into the service core.

Use these docs selectively:

- Read [docs/module-map.md](./docs/module-map.md) before making structural or cross-module changes.
- Read [docs/state-authority.md](./docs/state-authority.md) before changing persistence, reconciliation, or ownership logic.
- Read [docs/persistence-audit.md](./docs/persistence-audit.md) when adding or removing stored fields, changing DB tables, or reclassifying data as authoritative versus derived.

Working guidance:

- Keep SQLite focused on harness coordination and restart-safe ownership state.
- Treat raw event history, reports, and operator-facing views as derived unless a change truly needs them for correctness.
- Prefer small boundary-tightening changes over broad refactors.
