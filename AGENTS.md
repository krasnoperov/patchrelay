# PatchRelay Agent Guide

PatchRelay is being redesigned as a **Linear-centered agentic software factory**.
Treat this repository as a fresh-start architecture effort, not as an extension of the older staged-run design.

## Start Here

Read these in order:

1. [ARCHITECTURE.md](./ARCHITECTURE.md) for the system map and dependency rules.
2. [PRODUCT_SPEC.md](./PRODUCT_SPEC.md) for product requirements and scope.
3. [docs/design-docs/index.md](./docs/design-docs/index.md) for design principles and deeper references.
4. [docs/architecture.md](./docs/architecture.md) for the detailed control-plane design.
5. [docs/product-specs/index.md](./docs/product-specs/index.md) for product-facing requirements and future specs.

## Core Intent

PatchRelay should:

- receive delegated work through **Linear Agent Sessions**
- orchestrate long-running work in **isolated git worktrees**
- run implementation and repair loops through **Codex**
- use **GitHub** as the canonical source of PR, review, and check truth
- treat **merge queues as pluggable providers**, with Graphite as the first target

PatchRelay should not:

- treat Linear as only a generic issue queue
- hide workflow state inside prompts alone
- couple the product to one merge queue vendor
- preserve old architecture decisions unless they survive the new design docs

## Working Rules

- Prefer short root docs and deeper `docs/` pages over one giant instruction file.
- Keep human-facing progress in Linear through native session activities and plans.
- Keep the human accountable in Linear; the agent acts as the delegate.
- Use one owning agent per issue branch. Additional agents, if any, are helpers inside that issue workflow.
- Reuse the same worktree for implementation, review fixes, CI fixes, and merge-queue repair.
- Treat CI repair and queue repair as distinct loops with separate retry budgets.
- Keep repo-specific workflow policy in versioned docs and config files, not in service code or ad hoc prompts.
- When product or architecture behavior changes, update the docs in the same change.

## Document Map

- [ARCHITECTURE.md](./ARCHITECTURE.md): top-level system map
- [PRODUCT_SPEC.md](./PRODUCT_SPEC.md): product requirements
- [docs/design-docs/core-beliefs.md](./docs/design-docs/core-beliefs.md): agent-first principles
- [docs/architecture.md](./docs/architecture.md): detailed component, state, and event design
- [docs/references/external-patterns.md](./docs/references/external-patterns.md): notes from external references
- [docs/archive/](./docs/archive): historical material only; not source of truth for the redesign

## If You Are Making Changes

For docs-only work:

- keep `AGENTS.md` concise
- push durable reasoning into `docs/`
- cross-link new documents from the existing indexes

For product or architecture work:

- update both [PRODUCT_SPEC.md](./PRODUCT_SPEC.md) and [docs/architecture.md](./docs/architecture.md) when behavior changes
- preserve the separation between control plane, adapters, and execution runtime
- avoid pulling provider-specific behavior into shared orchestration logic

For implementation work later:

- make the app bootable per worktree
- prefer explicit contracts over implicit prompt conventions
- keep external integrations behind interfaces that are easy for agents to inspect

## Historical Caution

The repository contains older code and docs from multiple refactors.
Assume those artifacts are useful as reference material only if they agree with the current top-level docs.
If they disagree, the current design docs win.
