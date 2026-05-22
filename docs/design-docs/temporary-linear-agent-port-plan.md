# Temporary Plan: Linear Agent Port

Date: 2026-05-22

This is a temporary implementation plan, not durable architecture. Its job is to turn the Linear-agent research pass into focused PatchRelay work. The bias is: keep PatchRelay a GitHub-centered delivery harness with a good Linear operator surface, not a generic Linear agent clone.

## Implementation Status

Implemented from this plan:

- Phase 1: Linear agent-session prompts are treated as normal Codex chat input, explicitly addressed Linear issue comments are imported as Codex input, and unaddressed issue comments stay inert issue discussion. The structured classifier remains for narrow control decisions; explicit agent protocol signals remain deterministic.
- Phase 2: active-run prompts/comments carry a checkpoint contract, persist `prompt_delivered` success/failure events, surface delivery failures in operator and Linear-visible activity, and include steering counts in terminal summaries.
- Phase 3: every `review_fix` wake refreshes GitHub requested-changes context before launch, marks degraded refreshes explicitly, reports review-round starts, and ends review-fix responses with addressed/deferred/not-applicable sections plus resulting head when known.
- Phase 4: Linear progress reporting uses quiet-period heartbeats and terminal response/error policy.
- Conversation adapter refinement: active input uses `turn/steer`, idle input queues a same-thread follow-up wake, active status questions answer as ephemeral thoughts, and follow-up work on a completed PR reopens as replacement implementation with prior PR facts attached.

Not implemented:

- Phase 5 optional Linear label presentation. It remains non-essential polish and should stay derived presentation only if it is ever added.

## Goal

PatchRelay should become more reliable and legible in three places:

- Human follow-up prompts in the Linear agent session, and explicitly addressed issue comments, must reliably steer active work.
- Requested-changes repair must always work from first-party GitHub review context.
- Linear-visible progress must be concise, typed, and useful without turning the issue into a chat log.

The Linear label idea is useful only as optional demonstration/read-model polish. It should not become orchestration truth.

## Non-Goals

- Do not add a default plan-approval gate before implementation. PatchRelay's product promise is autonomous delivery.
- Do not add per-review-round Linear labels such as `review-round-1`.
- Do not write general-purpose state files into target repositories.
- Do not add sub-issue spawning or multi-agent orchestration.
- Do not route ordinary human intent through regex keyword gates.

## Phase 1: Replace Brittle Follow-Up Intent Routing

Problem: PatchRelay currently classifies human follow-up text with regex patterns. That conflicts with the project rule that natural-language operator input should not be routed by brittle parsing.

Implementation:

- Treat the Linear agent session as the normal chat surface for PatchRelay.
- Treat Linear issue comments as issue discussion unless the comment explicitly addresses PatchRelay at the start, such as `PatchRelay, ...` or `@PatchRelay ...`.
- Introduce a structured follow-up intent classifier for accepted input.
- Inputs: prompt/comment body, source (`agentPrompted` or explicitly addressed Linear comment), active run type, current factory state, whether the issue is awaiting input, delegation state, PR/review state.
- Output a small explicit enum, for example:
  - `stop`
  - `status`
  - `resume_or_retry`
  - `implementation_instruction`
  - `answer_to_question`
  - `context_only`
  - `unknown_needs_ack`
- Use deterministic handling only for machine-owned protocol fields and explicit Linear agent signals.
- Keep a conservative fallback: if accepted input is uncertain while a run is active, deliver it into the active turn as context rather than discarding it.
- Do not import unaddressed issue comments, including comments on `awaiting_input` issues, because they are not necessarily intended as agent input.

Likely code:

- Replace or shrink `src/followup-intent.ts`.
- Update `src/webhooks/agent-session-handler.ts`.
- Update `src/webhooks/comment-wake-handler.ts`.
- Add a small policy module if the handlers start mixing classification, state inspection, and side effects.

Tests:

- Unit tests for classifier fixtures with ordinary language, including:
  - "actually use the existing API instead"
  - "pause this"
  - "what is happening?"
  - "that answers my question, continue"
  - "FYI the customer is on enterprise"
  - "no action needed"
- Handler tests proving accepted non-actionable text is not silently dropped when there is an active run.
- Handler tests proving unaddressed issue comments do not wake work.
- Handler tests proving addressed issue comments strip the PatchRelay salutation before becoming agent input.
- Regression test that `agentSignal: stop` bypasses classifier ambiguity.

Docs:

- Update `docs/architecture.md` in the Linear/session section with the rule: natural-language follow-up goes through structured classification; explicit protocol signals remain deterministic.
- Update `docs/operator-guide.md` with examples of follow-up behavior.

## Phase 2: Make Prompted Steering a Real Checkpoint Contract

Problem: PatchRelay already forwards `agentPrompted` into active Codex turns, but the user-visible contract is only "delivered." The desired behavior is stronger: the active workflow should fold the prompt into its next decision point and visibly acknowledge the steer.

Implementation:

- Define "checkpoint-aware steering":
  - Do not kill arbitrary in-flight shell commands by default.
  - Deliver the prompt immediately to the turn.
  - Require the agent scaffold to acknowledge the new instruction before the next meaningful side effect when possible.
  - If a run cannot accept steering, record and surface that as a system/operator event.
- Persist a small prompt-delivery record with source, timestamp, active run id, and delivery status.
- On run completion, include whether follow-up prompts were incorporated or failed delivery.

Likely code:

- `src/webhooks/agent-session-handler.ts`
- `src/webhooks/comment-wake-handler.ts`
- `src/codex-app-server.ts` or prompt scaffold files under `src/prompting/`
- Run/session event persistence in the existing issue-session event path.

Tests:

- Active run + `agentPrompted` delivers to `codex.steerTurn`.
- Active status prompt answers as an ephemeral thought rather than closing the session.
- Delivery failure records an operator event and Linear activity.
- Prompt arriving while no active run queues the correct follow-up wake.
- Prompt echo from PatchRelay activity is ignored.
- Prompt on a completed PR queues replacement implementation and carries the previous PR facts.

Docs:

- Add a "Steering active work" subsection to `docs/architecture.md`.
- Add operational troubleshooting notes to `docs/operator-guide.md`.

## Phase 3: Own Requested-Changes Context End to End

Problem: Review-fix work must never depend on Linear relaying GitHub review context. PatchRelay already fetches latest requested-changes review context, but the behavior should be made explicit, tested, and visible.

Implementation:

- On every requested-changes repair wake, fetch from GitHub:
  - latest requested-changes review id
  - review body
  - inline review comments
  - review commit SHA
  - current PR head SHA
  - reviewer login
- Persist the blocking review SHA/head SHA relationship.
- Preserve the existing rule: a requested-changes repair must not return the same PR head to review unless the only valid change was a non-diff update such as PR body edits.
- Emit a review-round start activity:
  - "Review round N started from @reviewer on head SHA abc123; M comments captured."
- Emit a review-round completion response:
  - addressed comments
  - deferred comments, if any
  - resulting head SHA or explicit no-diff explanation

Likely code:

- `src/remote-pr-review.ts`
- GitHub webhook state projector / requested-changes handling
- Prompt context construction in `src/prompting/patchrelay.ts`
- Run finalization / publication checks that enforce new-head behavior
- Linear reporting in `src/linear-session-reporting.ts`

Tests:

- Requested-changes webhook captures review body and inline comments.
- Review-fix prompt includes captured comments and review SHA.
- Run finishing with unchanged blocking head becomes system failure.
- Run finishing with valid PR-body-only edit is allowed only through an explicit path.
- Review-round start/completion activities are emitted once.

Docs:

- Update `docs/github-queue-contract.md` requested-changes section.
- Update `docs/architecture.md` run lifecycle section.
- Add a short operator-guide entry for "review comments missing" and how PatchRelay recovers from GitHub.

## Phase 4: Tighten Linear Activity Policy

Problem: AgentActivities are already in use, but the policy should be more intentional. Linear should show what matters without becoming a raw transcript.

Implementation:

- Define an activity emission policy:
  - `thought`: phase transitions, concise findings, quiet-period heartbeat.
  - `action`: meaningful side effects, such as starting implementation, verification, publication, PR creation, or review repair.
  - `elicitation`: real user decision needed.
  - `response`: terminal human-readable summary.
  - `error`: terminal failure requiring attention.
- Keep noisy progress ephemeral by default.
- Persist only stable milestones to the activity history.
- Add timed heartbeat for long quiet periods, especially CI waits and long test runs. Prefer one heartbeat every 10-15 minutes, not a stream of narration.

Likely code:

- `src/linear-progress-reporter.ts`
- `src/linear-progress-facts.ts`
- `src/linear-session-reporting.ts`
- `src/linear-session-sync.ts`

Tests:

- Progress reporter deduplicates repeated facts.
- Ephemeral thoughts do not become duplicate historical activities.
- Heartbeat emits after configured quiet interval and resets on meaningful progress.
- Terminal response/error is emitted exactly once per run outcome.

Docs:

- Add a concise "Linear activity policy" section to `docs/architecture.md`.
- Keep `docs/operator-guide.md` focused on what users will see, not implementation details.

## Phase 5: Optional Linear Labels for Demonstration

This is deliberately lower priority.

Useful version:

- Use labels only as operator-visible hints for current coarse phase when the workspace wants that demo surface.
- Examples:
  - `agent:implementing`
  - `agent:review-fix`
  - `agent:waiting-input`
  - `agent:queued-for-deploy`

Rules:

- Labels are derived from PatchRelay state, never authoritative.
- Labels must be configurable or disabled.
- PatchRelay must reconcile labels idempotently.
- Do not encode round numbers, detailed progress, prompt state, or blocking review identity into labels.

Tests:

- Label sync is idempotent.
- Label sync failures do not block orchestration.
- Derived labels are removed when the issue leaves the phase.

Docs:

- If implemented, document as optional workspace presentation in `docs/operator-guide.md`.
- Do not describe labels as state storage.

## Suggested Order

1. Phase 1: classifier and routing policy.
2. Phase 2: checkpoint steering contract.
3. Phase 3: requested-changes context and review-round summaries.
4. Phase 4: activity emission policy and heartbeats.
5. Phase 5: optional label presentation.

The first three phases are the important work. Phase 4 improves trust and operator experience. Phase 5 is polish.

## Acceptance Criteria

- Natural-language agent-session follow-up no longer gets dropped or misrouted because it lacked a magic keyword.
- Issue comments steer the agent only when explicitly addressed to PatchRelay.
- Completed-PR follow-up creates replacement implementation context instead of mutating the historical PR.
- An active run visibly acknowledges prompt steering or surfaces delivery failure.
- Review-fix runs always include first-party GitHub review context.
- PatchRelay refuses to hand the same requested-changes PR head back to review after a repair run.
- Linear session activity shows concise milestones and final summaries, not raw transcript noise.
- Optional labels, if shipped, are derived presentation only.
