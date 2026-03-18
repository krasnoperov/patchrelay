# Orchestration Requirements

## Purpose

This document captures the architectural requirements for PatchRelay's pipeline orchestration layer.
It builds on [workflow-requirements.md](workflow-requirements.md), which defines the desired
end-to-end behavior, and adds the architectural decisions informed by landscape research.

This document is about architecture, not wire format. It specifies what components exist, what each
owns, and how they relate. It does not specify schemas, table layouts, or prompt templates.

The goal is to keep the architecture as small as possible while still supporting automatic
continuation across stages. Supporting docs cover workflow selection, transition evidence, and
stage prompt expectations:

- [workflow-selection.md](workflow-selection.md)
- [transition-evidence.md](transition-evidence.md)
- [stage-prompt-contract.md](stage-prompt-contract.md)

## Architecture: Three Layers

PatchRelay's orchestration is built from three distinct layers. Each layer has a single
responsibility and a clear boundary with the others.

### Layer 1: Linear Session (Presentation)

One active `AgentSession` per delegated pipeline run. This is the human-facing surface.

An issue may have multiple sessions over its lifetime (re-delegation, mentions, resumed work). The
requirement is one active session per pipeline run, not one session for the lifetime of the issue.

Responsibilities:

- present the entire issue pipeline as one continuous delegated story
- post stage transition messages when the FSM changes state
- display the current plan checklist via Linear's Plan tool (written by the FSM orchestrator)
- surface agent thoughts, actions, and errors from the active stage
- accept human interrupts, redirects, and new instructions

Not responsible for:

- deciding what stage to run next
- executing agent work
- persisting pipeline state

The Linear session is a presentation layer, not an execution layer. PatchRelay may use different
internal Codex turns or workers for different stages while keeping one Linear session as the
external-facing continuity surface.

### Layer 2: FSM Orchestrator (Control)

A deterministic state machine in the harness that owns the issue lifecycle.

Responsibilities:

- track current pipeline state for each active issue
- enforce valid transitions based on stage outcomes and workflow policy
- manage loop counters and timeout limits per transition or stage as required by workflow policy
- trigger stage execution when a transition occurs
- construct carry-forward context for the next stage
- own all Linear session plan updates (sole writer to the Plan API)
- post transition messages into the Linear session
- check continuation preconditions before advancing (delegation still active, no human override)

Not responsible for:

- deciding how to implement, review, or deploy (that is the agent's job)
- inventing new stages or transitions at runtime
- holding the agent's working context

The FSM is code, not a prompt. Stage transitions are driven by stage outcomes that the FSM can
interpret, not by free-form LLM reasoning. The exact shape of those outcomes is an implementation
choice — see the Stage Outcome Model section below.

### Layer 3: Stage Agent Execution (Work)

Per-stage agent runs that perform the actual implementation, review, or deploy work.

Responsibilities:

- execute the work defined by the current stage using Codex or equivalent
- operate within a fresh context loaded with carry-forward from the prior stage
- produce an outcome that the FSM can use to determine the next transition
- report progress to the FSM, which owns all Linear session and plan updates
- respect stage-specific tools, guardrails, and repo workflow policies

Not responsible for:

- deciding what stage to run next (that is the FSM's job)
- managing the Linear session lifecycle
- persisting cross-stage state

Each stage runs in a fresh context. The agent does not inherit the raw context of prior stages. It
receives only the carry-forward payload constructed by the FSM orchestrator.

## Simplification Principles

PatchRelay should prefer the smallest architecture that preserves the required behavior.

In practice, that means:

- one generic FSM engine, not a full workflow platform
- one default workflow backbone with optional repo overrides
- one stage runner abstraction reused across implementation, review, and deploy
- lightweight handoffs rather than a rich mandatory stage-outcome protocol
- deterministic routing rules by default
- `Human Needed` as the preferred escape hatch when the next step is unclear
- no requirement for internal multi-agent orchestration inside a stage

## Workflow Definition Model

### Workflows Are Repo-Configured, Not Agent-Discovered

The set of stages and valid transitions for an issue is defined by repo workflow policy, not
discovered by an LLM at runtime. Different task types may have different pipelines.

Examples of workflow types a repo might eventually define:

- `feature`: implementation → review → deploy
- `bugfix`: reproduce → fix → verify → deploy
- `investigation`: research → report
- `hotfix`: fix → fast_review → deploy
- `docs`: write → review → publish

Which workflow applies to a given issue is determined by labels, issue type, or repo policy. The
FSM engine is generic and reads a workflow definition. Adding a new workflow type is adding
configuration, not rewriting the orchestrator.

However, the implementation should start simpler than the fully general model:

- default to one standard workflow: `implementation -> review -> deploy`
- support repo-specific overrides only where needed
- avoid building a highly dynamic workflow-definition system before a real repo needs it

### Stage Naming

This document uses stage names as prose examples, not as canonical identifiers. The mapping between
internal stage identifiers and Linear issue states (e.g., `Start`, `Review`, `Deploy`) is a
repo-level configuration concern. The implementation should define this mapping explicitly rather
than letting it drift across code and config.

### Default Workflow

The default workflow when no repo-specific override applies:

- stages: `implementation`, `review`, `deploy`
- terminal states: `done`, `human_needed`
- valid transitions: as defined in workflow-requirements.md

### Workflow Definition Shape

A workflow definition specifies:

- the ordered set of stages
- valid transitions between stages (including loops back)
- which transitions are deterministic vs require classification
- stage-specific configuration (prompts, tools, guardrails)
- loop limits per transition type
- carry-forward requirements per transition

The exact encoding is an implementation choice. The requirement is that workflows are declarative
policy, not imperative code scattered across the harness.

The implementation should start with the smallest policy surface that works. It does not need a
fully general DSL or graph editor.

## Stage Outcome Model

Each stage produces an outcome that the FSM uses to determine the next transition.

### What the FSM Needs From a Stage Outcome

The FSM needs to answer two questions after a stage completes:

1. what transition should fire (i.e., where does the issue go next)
2. what carry-forward context does the next stage need to start safely

The exact shape of how stage outcomes encode this is an implementation choice. A lightweight
approach should be preferred first:

- let the FSM infer the next transition from issue state, CI status, repo facts, and a compact
  stage summary
- require only the minimum durable facts needed for the next stage
- introduce richer structured outcome fields only when a real ambiguity or reliability gap requires
  them

This document does not mandate a large typed verdict/evidence schema on day one.

See [stage-prompt-contract.md](stage-prompt-contract.md) for the minimal stage completion and
harness communication expectations.

### Transition Logic

However the outcome is encoded, the FSM maps `(current_stage, outcome)` to `next_stage`. Most
mappings should be deterministic. For the default workflow:

- `implementation` completes successfully → `review`
- `review` approves → `deploy`
- `review` finds fixable issues → `implementation`
- `deploy` ships successfully → `done`
- `deploy` finds fixable code issue → `implementation`
- any stage cannot determine a clear next step → `human_needed`

The only transition that may require classification is `deploy` failure routing: is the failure a
code problem (→ `implementation`) or a review/approval readiness problem (→ `review`)? All other
transitions should be deterministic from the outcome.

Even here, PatchRelay should start with explicit rule-based routing where possible and only add an
LLM-based classifier if real cases remain ambiguous after deterministic checks.

### Outcome Boundaries

The FSM must be able to distinguish "clear next stage" from "ambiguous." If the FSM cannot
confidently determine the next transition from whatever the stage produced, it should route to
`human_needed` rather than guessing.

## Context Management

### Fresh Context Per Stage

Each stage starts with a clean agent context. The agent does not inherit the raw conversation
history of prior stages.

Rationale:

- different stages need different context (implementation needs code files and specs; review needs
  diffs and test results; deploy needs CI status and merge readiness)
- prior-stage context actively degrades current-stage performance through attention dilution
- fresh contexts are cheaper and produce better results than compacted mega-sessions
- stage prompts can be tested and tuned independently

### Carry-Forward Context

The FSM constructs carry-forward context for each transition. This is the only prior-stage
information the next stage receives.

Carry-forward should include:

- what the prior stage concluded and why
- artifacts the next stage needs (branch, PR, findings, diagnostics)
- cycle count and loop history (so the agent knows this is attempt N)

Carry-forward should not include:

- the prior stage's internal reasoning or tool call history
- raw file contents already available in the repo
- stale context from stages before the prior one

Target size: a compact handoff, roughly on the order of ~1-2K tokens when serialized. Enough for
the next stage to act without manual reconstruction. Not so much that it recreates the
accumulated-session problem.

PatchRelay should optimize for "small and sufficient," not "capture everything."

### Durable State

The FSM persists durable state outside the agent context:

- current stage per issue
- cycle counts per transition type
- recent stage results needed for audit, retry limits, and safe continuation
- carry-forward payloads (for crash recovery)

The persistence model is an implementation choice. The requirement is that pipeline state survives
agent restarts and is inspectable for debugging.

The implementation should keep this state minimal. PatchRelay does not need to persist rich derived
agent chatter if the FSM can operate from a smaller coordination record.

## Linear Plan Integration

### Plan as FSM Projection

The Linear Plan tool displays a session-level checklist. PatchRelay uses it as a projection of the
FSM state, not as a control mechanism.

Start simple:

- always support macro steps: the pipeline stages with their FSM status
- support micro steps only when they clearly improve the user experience for the active stage

### Plan Ownership

The FSM orchestrator is the sole owner of plan state and the sole writer to the Linear Plan API.

Linear's plan API requires full-array replacement on every update. If both the FSM and the stage
agent wrote to the plan independently, they would race and overwrite each other. To avoid this:

- the FSM holds the canonical plan array
- the stage agent reports sub-task progress to the FSM (not directly to Linear)
- the FSM merges macro and micro steps into the canonical array and writes it

### Plan Update Flow

- FSM enters `implementation` → plan shows implementation (inProgress), review (pending), deploy
  (pending)
- agent may optionally report sub-task discovery → FSM adds micro steps under the current stage
- agent may optionally report sub-task completion → FSM marks micro steps completed
- FSM transitions to `review` → FSM collapses prior micro steps, shows implementation (completed),
  review (inProgress), deploy (pending)

PatchRelay does not need a deep mirrored task tree in Linear. A small, legible plan is enough.

## Stage Runner Model

PatchRelay should reuse one stage runner abstraction across workflow stages.

Each stage should be configurable through a small set of inputs such as:

- stage prompt/instructions
- available tools or restrictions
- verification expectations
- completion interpretation rules

PatchRelay should avoid building separate orchestration subsystems for implementation, review, and
deploy. Variation should live in stage configuration and repo workflow policy, not in bespoke
runner machinery.

## Loop Safety

### Core Guardrails

1. **Hard cap**: maximum N cycles per transition type (configurable per workflow, default 3).
   Exceeding the cap routes to `human_needed` regardless of verdict.

2. **Wall-clock timeout**: maximum duration per stage execution. Prevents silent stalls. Exceeding
   the timeout routes to `human_needed`.

These two checks should be the required loop-safety model. Transition validation and human
escalation are specified separately in this document and complete the core workflow-safety posture.

### Escalation Evidence

When escalating to `human_needed`, the FSM should provide:

- number of cycles attempted
- specific failure pattern observed
- what changed (or didn't change) between iterations
- why automatic resolution appears unlikely

Escalation is a feature, not a failure. The architecture should stay biased toward simple, safe
stops rather than increasingly elaborate recovery logic.

## Continuation Preconditions

Before starting the next stage automatically, the FSM must verify:

- the issue is still delegated to PatchRelay
- no human has moved the issue to an unrelated state
- no human has added conflicting instructions since the last stage started
- the carry-forward context is sufficient for the next stage
- loop limits have not been exceeded

If any precondition fails, the FSM should stop and either wait or escalate rather than proceeding
blindly.

## Non-Goals

This document does not specify:

- whether stage outcomes use a structured schema (verdict enum + evidence payload) or a lighter
  model (FSM infers transitions from issue state and repo facts) — both are valid starting points
- the exact persistence schema (SQLite tables, column names)
- the exact prompt templates per stage
- the exact Codex app-server API calls
- the exact workflow definition file format
- the exact Linear Plan update protocol
- canonical internal stage identifiers or their mapping to Linear states
- internal multi-agent decomposition inside a stage

Those are implementation choices to make after these architectural requirements are accepted.

## Relationship to Other Documents

- [workflow-requirements.md](workflow-requirements.md): defines the desired end-to-end behavior
  that this architecture must satisfy
- `~/vault/notes/research/20260317_agent_pipeline_orchestration_patterns.md`: landscape research
  supporting these architectural decisions
- `~/vault/notes/research/20260317-patchrelay-agent-pipeline-landscape.md`: PatchRelay-specific
  pattern analysis supporting these decisions
