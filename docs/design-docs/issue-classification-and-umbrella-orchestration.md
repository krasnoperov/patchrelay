# Issue Classification And Umbrella Orchestration

## Purpose

PatchRelay should have a simple, universal mental model for delegated work.

The core problem is not that umbrella issues need many special cases.
It is that PatchRelay currently treats too many delegated issues as if they are all code-owning implementation issues.

This document proposes a simpler model:

- `implementation`
- `orchestration`

That is enough to cover ordinary coding issues and umbrella issues without forcing PatchRelay to maintain too many special agent modes.

## Core Model

PatchRelay should classify each delegated issue into one of two session types:

- `implementation`
- `orchestration`

These are issue-level session types.
They are separate from repair run types like `review_fix`, `ci_repair`, and `queue_repair`.

### Implementation

Use `implementation` when the issue owns a concrete slice of work.

Characteristics:

- one issue is expected to directly produce progress in the repository
- the main artifact is usually a PR, or a trusted no-PR completion
- review, CI, and merge-queue events remain first-class follow-up surfaces

Behavior:

- keep today's implementation prompt and context model
- do not try to distinguish PR versus no-PR in orchestration ahead of time when there are no stronger signals
- after no-PR completion, continue to run the fast follow-up completion check

### Orchestration

Use `orchestration` when the issue owns a set of related work items rather than one direct implementation slice.

Characteristics:

- the issue is usually a parent, umbrella, tracker, rollout, or convergence issue
- child issues own most of the concrete implementation work
- the parent may still do a small amount of direct work, but that is not the default expectation

Behavior:

- start with an orchestration-specific prompt
- receive current child issue summaries as primary context
- wake whenever something meaningful changes in the child set or the human guidance
- do not open an overlapping umbrella PR by default
- let the agent decide whether it is preparing work, waiting, auditing delivered work, creating follow-ups, doing a small cleanup PR, or closing the umbrella

## Why This Model Is Better

This keeps the mental model simple:

- implementation sessions implement
- orchestration sessions babysit convergence

It avoids over-modeling `coordination` and `finalization` as separate stored classes.
Those are still useful concepts, but they should be treated as phases of orchestration behavior, not as separate top-level issue classes.

That means an orchestration session can naturally do all of these things over time:

- initial planning or splitting
- waiting on child issues
- checking delivered child work
- creating a justified follow-up
- doing final audit
- closing the parent

without PatchRelay needing to constantly switch the issue into a new stored class.

## Classification Rules

PatchRelay should classify from structured issue context first.

Preferred signals, strongest first:

1. Explicit PatchRelay issue class field or label.
2. True Linear parent/sub-issue relationships.
3. Team or repo guidance that marks a template or label as orchestration-oriented.
4. Heuristic fallback:
   - issue has active child work and reads like a tracker or umbrella -> `orchestration`
   - otherwise -> `implementation`

Design rule:

- `implementation` remains the default
- `orchestration` should be selected only when there is real evidence that the issue owns related work rather than a single direct code slice

## Orchestration Lifecycle

An orchestration session should be event-driven.
It should not stay permanently active.

The orchestration session wakes, looks at what changed, does the minimum useful work, records a concise outcome, and then waits again.

Useful orchestration phases include:

- initial setup
- child monitoring
- delivered-work review
- final audit
- follow-up creation
- closeout

These are phases of the same orchestration session type, not separate issue classes.

### Initial Setup

At first wake, the agent should:

- inspect the parent issue goal
- inspect the current child set
- decide whether the child set is sufficient
- create or refine follow-up issues if the task explicitly requires that
- record a concise plan in Linear

### Ongoing Babysitting

When child issues move, the agent should:

- inspect what changed
- decide whether that change affects the umbrella plan
- optionally create or update follow-up work
- otherwise record the observation and return to waiting

### Final Audit

When the child set looks largely delivered, the agent should:

- review the aggregate outcome against the parent goal
- decide whether the umbrella can close
- decide whether a small cleanup PR is enough
- decide whether a justified follow-up issue is required

This is the old "finalization" idea, but it should remain behavior within orchestration rather than a separate stored class.

## Prompt Strategy

The prompt difference should stay simple.

### Implementation Prompt

Keep current behavior.

Context package:

- issue details
- current branch/worktree state
- PR/review/CI context when relevant
- tracked blockers and dependents as advisory context only

Instruction style:

- solve the delegated issue directly
- publish a PR when code changes need review
- otherwise finish cleanly for no-PR completion check

### Orchestration Prompt

Treat the issue as the owner of convergence across related issues.

Context package:

- parent issue details
- full child issue summary list
- current wake reason
- recent relevant human comments
- prior orchestration summaries

Instruction style:

- understand why this wake happened
- inspect the current child set before acting
- do not create an overlapping umbrella PR unless the parent clearly owns direct cleanup work
- if child work is still in motion, babysit the plan and wait
- if child work is delivered, audit whether the parent goal is actually satisfied
- create blocking follow-up work only when it is necessary to satisfy the original parent goal
- prefer non-blocking follow-up issues over keeping the umbrella open for optional polish
- when the original parent goal is satisfied, close the umbrella

The important design choice is:

- PatchRelay tells the orchestration agent why it woke up
- the agent decides whether this wake is planning, babysitting, or final audit work

## Wake Model

The wake model should remain small and legible.

Recommended orchestration wake reasons:

- `initial_delegate`
- `child_changed`
- `child_delivered`
- `child_regressed`
- `all_children_delivered`
- `human_instruction`
- `direct_reply`

Implementation keeps its current wake surfaces, including review and repair contexts.

The important point is not the exact taxonomy.
The important point is that the wake reason explains why the agent is running now.

### Wake Semantics

For orchestration:

- `initial_delegate`: prepare the work program
- `child_changed`: inspect whether the change affects the plan
- `child_delivered`: inspect the delivered child and decide if anything must change
- `child_regressed`: check whether the umbrella can still converge cleanly
- `all_children_delivered`: run final audit
- `human_instruction`: update the plan or scope
- `direct_reply`: resume from a PatchRelay question with strong user intent

PatchRelay should prefer event-driven resume over polling.

That means:

- persist wake-worthy child and comment events
- coalesce duplicate wakes when practical
- keep child summaries compact rather than forwarding raw transcripts

## Convergence Guardrails

The orchestration agent must not turn the umbrella into an endless backlog generator.

The essential rule is:

- new blocking work is allowed only when it is necessary to satisfy the original parent goal

Everything else should be:

- a non-blocking follow-up
- or a human decision

Recommended minimal safeguards:

1. Record when a follow-up issue was created from the umbrella.
2. Distinguish blocking versus non-blocking follow-up.
3. Allow one automatic blocking follow-up wave for an umbrella.
4. Require human confirmation before repeated blocking expansion beyond that first wave.

This gives the agent enough room to catch one real missed slice without encouraging endless invention of adjacent work.

## Comment Handling

Comments should use the same simple model for both session types.

Normalize comments into:

- `direct_reply`
- `followup_instruction`
- `non_actionable_comment`

That is usually enough.

### Direct Reply

Use when a human is replying to a PatchRelay question or elicitation.

Behavior:

- resume the relevant session on the same thread
- treat the reply as high-priority new context

### Follow-Up Instruction

Use when a human gives meaningful new guidance.

Behavior in implementation:

- queue a follow-up implementation turn
- keep the issue focused on the same code-owning task

Behavior in orchestration:

- wake the orchestration session
- let the agent decide whether the instruction changes planning, child setup, or final audit judgment

### Non-Actionable Comment

Use for comments that do not clearly change the work.

Behavior:

- record them if useful
- do not automatically wake a new run

## Linear Representation

Linear should show what PatchRelay is doing without exposing internal machinery.

### Agent Session Activities

Use concise semantic activities:

- `thought`: acknowledge the wake and next step
- `action`: describe a short visible action
- `response`: describe the outcome of the wake
- `elicitation` or `error`: only when human input is actually needed

For orchestration, the best activities are short and situational:

- "Reviewing child deliveries"
- "Updating rollout plan"
- "Final audit shows one missing blocking slice"
- "Recorded non-blocking cleanup follow-up"

### Agent Session Plans

Implementation can keep the current four-step plan.

Orchestration should use a simple reusable plan such as:

1. Review umbrella goal and child set
2. Wait for or inspect child progress
3. Audit delivered outcome
4. Close umbrella or create follow-up work

This is good enough for planning, babysitting, and final audit without inventing multiple orchestration plan types.

### External URLs

Implementation should keep surfacing the active PR when present.

Orchestration should prefer:

- the parent issue URL
- relevant child issue URLs if supported
- a cleanup PR URL only when the parent really owns such a PR

Do not imply that an orchestration session is "PR-bound" when the right outcome is observation and convergence management.

## Data Model Changes

Keep the new model light.

Minimum useful additions:

- `issueClass`: `implementation | orchestration`
- `issueClassSource`: `explicit | hierarchy | heuristic`
- `parentLinearIssueId?`
- compact child summary read model for orchestration issues
- small counter or marker for blocking follow-up waves

The child summary read model should include:

- child issue id and key
- title
- current state
- delegate or assignee
- PR presence and PR state if relevant
- latest compact delivery summary
- regression marker when a previously delivered child becomes unready again

Avoid storing raw child transcripts in the parent issue record.

## Orchestration Changes In PatchRelay

### Run Launching

PatchRelay should choose launch behavior by issue class:

- `implementation` -> current launch and prompt builder
- `orchestration` -> orchestration prompt builder with child summaries and wake reason

### Session Planning

Agent session plan generation should depend on issue class first.
Do not assume every issue is walking the implementation PR pipeline.

### Wake Planning

Wake planning should support orchestration events from:

- child issue changes
- child completion or regression
- human comments
- direct replies

### Linear Sync

Linear plan and activity text should reflect whether the issue is implementing code or orchestrating related work.

## Concrete Implementation Checklist

This section maps the simplified design onto the actual PatchRelay files.

### 1. Add Issue Class To Stored Issue State

Goal:

- make `implementation` versus `orchestration` explicit and durable

Primary files:

- [src/db-types.ts](/home/alv/projects/patchrelay-issue-classification/src/db-types.ts:1)
- issue persistence layer in `src/db/` and related migrations

Checklist:

- add `issueClass?: "implementation" | "orchestration"` to `IssueRecord`
- add `issueClassSource?: "explicit" | "hierarchy" | "heuristic"`
- add a compact place to store orchestration child summaries or a child-summary read model
- add a small marker for orchestration follow-up expansion, such as `blockingFollowupWaveCount`

Notes:

- do not add separate stored classes for coordination/finalization
- keep the schema small; the point is to choose the right session type, not to encode every orchestration phase

### 2. Classify Issues Before Launch

Goal:

- choose session type before building the prompt or session plan

Primary files:

- [src/run-launcher.ts](/home/alv/projects/patchrelay-issue-classification/src/run-launcher.ts:1)
- any existing issue intake or sync path that already enriches issue records before launch

Checklist:

- add a classification helper that decides `implementation` versus `orchestration`
- prefer explicit config, then Linear hierarchy, then lightweight heuristics
- make `prepareLaunchPlan()` accept or derive the issue class
- keep run type logic intact for repairs; issue class and run type are separate dimensions

Notes:

- implementation issue with CI failure is still `implementation` plus `ci_repair`
- orchestration should usually launch with base run type `implementation` only if we keep the run-type enum unchanged initially; otherwise introduce a dedicated orchestration launch path later

### 3. Split Prompt Construction By Issue Class

Goal:

- keep today's implementation prompt stable
- add a distinct orchestration prompt that is wake-driven and child-aware

Primary files:

- [src/prompting/patchrelay.ts](/home/alv/projects/patchrelay-issue-classification/src/prompting/patchrelay.ts:1)

Checklist:

- keep the current implementation prompt path as the default
- extract the current umbrella-specific guidance out of `buildScopeDiscipline()` into a true orchestration path instead of mixing it into all implementation prompts
- add orchestration-specific prompt sections:
  - parent issue goal
  - child issue summaries
  - current wake reason
  - recent relevant human comments
  - prior orchestration summary if available
- add orchestration-specific publication guidance:
  - no overlapping umbrella PR by default
  - cleanup PR allowed only when the parent clearly owns direct cleanup work
  - blocking follow-up allowed only when needed for the original parent goal

Notes:

- today `buildCoordinationGuidance()` is implementation-adjacent advisory text
- after this change, orchestration should become a first-class prompt path rather than a warning embedded in implementation prompts

### 4. Introduce Orchestration Wake Planning

Goal:

- allow parent issues to wake from child progress and human guidance

Primary files:

- [src/run-wake-planner.ts](/home/alv/projects/patchrelay-issue-classification/src/run-wake-planner.ts:1)
- issue session event definitions and appenders

Checklist:

- keep current implementation repair wakes unchanged
- add orchestration-specific wake reasons in context:
  - `initial_delegate`
  - `child_changed`
  - `child_delivered`
  - `child_regressed`
  - `all_children_delivered`
  - `human_instruction`
  - `direct_reply`
- ensure wake dedupe keys account for child issue id or comment id when relevant
- resume orchestration sessions on the same thread where possible

Notes:

- the important change is not a giant new taxonomy
- the important change is that orchestration wakes are driven by child and human events, not only PR/CI/review events

### 5. Build Child Summary Context For Orchestration

Goal:

- give orchestration the current child set without stuffing raw transcripts into the prompt

Primary files:

- issue sync / read-model code
- [src/prompting/patchrelay.ts](/home/alv/projects/patchrelay-issue-classification/src/prompting/patchrelay.ts:1)

Checklist:

- define one compact child summary shape:
  - child key
  - title
  - state
  - delegate / assignee
  - PR presence / PR status
  - latest compact delivery summary
- feed that summary list into orchestration prompt context
- use the same summary list for Linear-facing explanations where helpful

Notes:

- this should be a compact read model
- avoid forwarding raw child session transcripts into the parent prompt

### 6. Make Session Plans Depend On Issue Class

Goal:

- stop assuming every issue follows the implementation PR pipeline

Primary files:

- [src/agent-session-plan.ts](/home/alv/projects/patchrelay-issue-classification/src/agent-session-plan.ts:1)
- [src/linear-agent-session-client.ts](/home/alv/projects/patchrelay-issue-classification/src/linear-agent-session-client.ts:1)

Checklist:

- add issue-class-aware plan generation
- keep the current implementation plan for implementation issues
- add a reusable orchestration plan, for example:
  - review umbrella goal and child set
  - wait for or inspect child progress
  - audit delivered outcome
  - close umbrella or create follow-up work
- keep repair-specific implementation plans intact

Notes:

- orchestration does not need separate stored plans for coordination versus finalization
- the same orchestration plan can represent planning, babysitting, and final audit phases

### 7. Reflect Issue Class In Linear Session Messaging

Goal:

- make it obvious in Linear whether PatchRelay is implementing or orchestrating

Primary files:

- [src/linear-agent-session-client.ts](/home/alv/projects/patchrelay-issue-classification/src/linear-agent-session-client.ts:1)
- any run-reporting or Linear activity helper files

Checklist:

- emit different thought/action phrasing for orchestration wakes
- keep orchestration activities short and situational:
  - reviewing child deliveries
  - updating rollout plan
  - final audit found one missing blocking slice
  - recorded non-blocking cleanup follow-up
- ensure external URLs do not imply a parent PR exists when the session is orchestration-only

Notes:

- Linear should show what changed and why the agent woke
- it should not force users to infer orchestration state from implementation-centric messaging

### 8. Route Comments By Simple Intent Model

Goal:

- reuse one small comment model across both session types

Primary files:

- webhook handling and comment decision helpers
- [src/prompting/patchrelay.ts](/home/alv/projects/patchrelay-issue-classification/src/prompting/patchrelay.ts:1)

Checklist:

- normalize comments into:
  - `direct_reply`
  - `followup_instruction`
  - `non_actionable_comment`
- implementation:
  - `direct_reply` and `followup_instruction` should wake the implementation session
- orchestration:
  - `direct_reply` and `followup_instruction` should wake the orchestration session
- non-actionable comments should be recorded but should not necessarily wake a run

Notes:

- this is intentionally smaller than a large comment taxonomy
- reuse the current `direct_reply` / `followup_comment` behavior where possible instead of reinventing everything

### 9. Add Minimal Convergence Guards

Goal:

- let orchestration create justified missing work without turning umbrellas into endless scope expansion

Primary files:

- orchestration prompt builder
- orchestration follow-up issue creation path
- stored issue metadata

Checklist:

- record when orchestration creates a follow-up issue
- mark whether the follow-up is blocking or non-blocking
- allow one automatic blocking follow-up wave
- require human confirmation for repeated blocking expansion beyond that wave

Notes:

- keep this rule small and mechanical
- do not build a heavy completion-contract system in the first implementation pass

### 10. Test The Split Explicitly

Goal:

- lock in the new mental model with prompt and planning tests

Primary files:

- prompt tests
- wake-planner tests
- Linear session plan tests

Checklist:

- add prompt tests proving:
  - implementation prompt stays unchanged for normal issues
  - orchestration prompt includes child summaries and wake reason
  - orchestration prompt forbids overlapping umbrella PRs by default
- add wake tests proving:
  - child delivery can wake orchestration
  - human instruction can wake orchestration
  - direct replies resume the same session thread
- add session-plan tests proving:
  - implementation issues still show the existing plan
  - orchestration issues show the orchestration plan

## Suggested Delivery Order

If we want the smallest useful implementation sequence, do it in this order:

1. Add `issueClass` storage and classification.
2. Add orchestration prompt path in `src/prompting/patchrelay.ts`.
3. Add orchestration wake reasons in `src/run-wake-planner.ts`.
4. Add orchestration session-plan rendering in `src/agent-session-plan.ts` and `src/linear-agent-session-client.ts`.
5. Add child summary context and minimal convergence guards.
6. Add tests for prompt, wake, and plan behavior.

That order gets the mental-model split into the system first, before layering on richer orchestration behavior.

## External References

These sources shaped the design:

- Linear agent interaction guidance: visible plans, semantic activities, prompt context, and immediate acknowledgement
  - https://linear.app/developers/agents
  - https://linear.app/developers/agent-interaction
  - https://linear.app/developers/agent-best-practices
- Linear hierarchy model: parent and sub-issues should be used when work is too large for one issue
  - https://linear.app/docs/parent-and-sub-issues
- OpenAI agent orchestration guidance: explicit handoffs, observable workflows, and flexible code-first orchestration
  - https://openai.com/business/guides-and-resources/a-practical-guide-to-building-ai-agents/
  - https://openai.com/index/new-tools-for-building-agents/
- PydanticAI multi-agent guidance: multi-agent systems need clear visibility and failure attribution
  - https://pydantic.dev/docs/ai/guides/multi-agent-applications/
- Claude Code and OpenClaw sub-agent guidance: focused roles, isolated context, event-driven completion, limited tool surfaces
  - https://code.claude.com/docs/en/sub-agents
  - https://docs.openclaw.ai/tools/subagents
