# Architecture Guardrails

Use this as the default guide when touching orchestrators, handlers, service shells, query builders, and persistence modules.

## Core rule

Keep top-level coordinators honest.

- Orchestrators coordinate phases. They should not accumulate detailed workflow policy.
- Policy modules decide what should happen. They should not quietly absorb persistence writes unless that write boundary is their explicit job.
- Query modules build read models. They should not enqueue work, create commands, or perform side effects.
- Persistence modules store and load data. They should not shape UI or operator-facing read models.

If a file starts mixing those concerns, stop and extract before adding more behavior.

## One-sentence test

Before expanding a file, ask:

- Can I describe this file's responsibility in one sentence?
- Does it have one main reason to change?
- Would the new behavior fit more naturally in a collaborator with a narrower role?

If the answer is "no" or "not really", do not keep growing the file.

## Preferred extraction order

When breaking up a growing file, prefer this order:

1. Extract pure policy and helper logic first.
2. Extract read and write boundaries second.
3. Extract side-effecting phase modules third.
4. Leave the top-level orchestrator as sequencing only.

This usually preserves behavior better than moving side effects first.

## Avoid fake abstractions

- Do not add wrappers that only forward calls.
- Prefer function modules over classes when no durable state is needed.
- Do not keep broad compatibility facades longer than necessary.
- If a new module only moves lines around without clarifying ownership, it is probably the wrong split.

## Preserve sequencing contracts

This matters most for webhook handlers and runtime flows.

- If a later phase depends on facts computed or written earlier, pass those facts explicitly.
- Do not rely on loosely re-deriving state in another module when the earlier phase already resolved it.
- When splitting a handler, keep the order of: resolve facts, project state, decide follow-up, perform side effects.

## Smells to stop on

Stop and refactor when a file starts doing several of these at once:

- routing or orchestration
- workflow policy decisions
- database writes
- GitHub or Linear API calls
- read-model assembly
- operator or UI formatting

That combination is how god files keep forming.
