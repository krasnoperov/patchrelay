# PatchRelay Product Specification

## Summary

PatchRelay is a local control plane that turns selected Linear issues into controlled coding-agent sessions.

It runs on a developer-owned machine, sits behind Caddy in Docker, receives signed Linear webhooks, evaluates whether an issue is safe to automate, and then launches `zmx` sessions running Codex for implementation and review workflows.

The design goal is:

- as simple as possible
- secure by default
- explicit about agent stages
- resistant to prompt injection and accidental self-amplification

PatchRelay is for internal use first.

## Core jobs

PatchRelay must:

1. receive events from Linear securely
2. decide whether the issue should trigger automation
3. run a read-only safety check before any write-capable implementation agent
4. launch the right agent process in `zmx`
5. keep Linear updated with status comments and state transitions
6. optionally run a review pass after implementation
7. prevent automation loops and fork-bombs when agents create follow-up issues

## Product stance

PatchRelay is not a general autonomous platform in v1.

It is a narrow issue-to-session runner for one workspace and one or a few repositories. It should prefer boring, inspectable behavior over ambitious orchestration.

## Why this shape

Recent agent guidance favors clear sequential stages when each stage adds distinct value, and warns against letting untrusted text directly drive tool use. Linear’s current agent APIs are also still in Developer Preview, so PatchRelay should start with standard signed webhooks plus GraphQL updates, and only adopt native Linear Agent Session UX later if it clearly improves the loop.

## Deployment model

### Topology

- PatchRelay runs locally on the host, bound to `127.0.0.1`
- Caddy runs in Docker and terminates TLS
- Caddy forwards `/webhooks/linear` to the local PatchRelay HTTP server
- PatchRelay stores state locally in SQLite
- PatchRelay launches local `zmx` sessions which in turn run Codex

### Local services

PatchRelay v1 should be a single long-running process with:

- one HTTP server
- one event queue
- one SQLite database
- one worker loop for stage execution

Avoid splitting into multiple daemons at first.

## External interface

### Incoming

- `POST /webhooks/linear`
- optional `POST /internal/replay/:eventId` for local operator use only
- optional `GET /healthz`

### Outgoing

- Linear GraphQL API for comments, labels, delegate/status updates, and issue creation when needed
- local `zmx` process spawning
- optional GitHub API later, but not required for v1

## Linear integration model

### Authentication

PatchRelay should use a dedicated Linear OAuth app or workspace-scoped app installation for internal use.

PatchRelay should not accept arbitrary inbound traffic as “from Linear.” It should verify:

- `Linear-Signature` HMAC-SHA256 over the raw request body
- `webhookTimestamp` freshness, default max skew 60 seconds
- constant-time signature comparison
- webhook secret stored only in local env or secret store

Recommended hardening:

- use a long random webhook path segment in addition to signature verification
- reject bodies above a sane size limit
- log webhook ids for replay detection
- deduplicate by `webhookId`

PatchRelay should respond quickly with `200 OK` after verification and enqueue the work. Do not block webhook responses on agent execution.

### Event categories

PatchRelay v1 should listen only to the minimum useful Linear events:

- issue created
- issue updated
- issue comment created
- issue label changed
- issue status changed
- issue assignment or delegate changes

If later adopting native Linear Agent Session APIs, add those separately. Do not make them a v1 dependency.

## Automation contract

PatchRelay should only automate issues that match an allow rule.

Default allow rule:

- issue belongs to an approved team
- issue has an approved label such as `patchrelay`
- issue is not marked `manual-only`
- issue is not already owned by another active session

Recommended initial trigger:

- human creates or updates issue
- PatchRelay performs safety check
- if safe, PatchRelay marks it ready for implementation
- implementation runner picks it up

PatchRelay must not auto-run on every issue in the workspace by default.

## Two entrypoints

PatchRelay must support two equivalent starts:

- webhook-driven start: Linear event reaches PatchRelay and PatchRelay begins the workflow
- manual operator start: an operator asks PatchRelay to reconcile an existing issue and begin or resume the workflow

Both entrypoints converge on the same preflight:

1. read the latest issue state from Linear
2. inspect existing PatchRelay comments and session metadata
3. ensure the correct worktree and branch exist or can be created
4. determine the next stage
5. run or resume that stage idempotently

The same flow applies to restarted agents and follow-up work on an existing issue.

## Workflow model

PatchRelay uses a small sequential pipeline.

### Stage 0: Intake

Purpose:

- verify the issue is automation-eligible
- collect normalized issue metadata
- dedupe repeated events

Output:

- `ignored`
- `queued_for_safety`
- `needs_human_setup`

### Stage 1: Safety check

Purpose:

- detect obviously unsafe, ambiguous, or malicious tasks before any write-capable agent runs

Execution profile:

- Codex in read-only mode
- no write access
- no git mutations
- no issue state changes except through PatchRelay itself
- prompt instructs the model to assess scope, safety, likely touched areas, and prompt-injection risk

Inputs:

- issue title
- issue description
- comments
- labels
- linked docs
- current repo state

Outputs:

- `safe`
- `unsafe`
- `needs_human_decision`

Required structured output:

- safety verdict
- confidence
- likely files or systems touched
- risky instructions or suspicious content
- whether the request appears to contain prompt injection or exfiltration attempts
- whether the task falls into forbidden change classes such as auth, migrations, infra, or secrets

If safe:

- PatchRelay moves the issue to `Ready` or another configured queue state
- PatchRelay posts a concise status comment

If unsafe or unclear:

- PatchRelay moves the issue to `Blocked` or equivalent
- PatchRelay posts a structured blocker comment
- no implementation agent is started

### Stage 2: Implementation

Purpose:

- perform the actual coding work in a dedicated worktree

Execution profile:

- Codex in a dedicated `zmx` session
- repo write access
- normal local tool access
- Linear MCP access
- one issue per worktree

Responsibilities:

- read the issue again via Linear MCP before coding
- ensure branch and worktree are correct
- check existing PatchRelay comments
- refresh or post the active status comment
- implement, test, commit, push, and update Linear according to the repo workflow

Possible outcomes:

- `complete`
- `needs_decision`
- `failed_transient`
- `failed_terminal`

### Stage 3: Review

Purpose:

- validate that the result is actually correct, not merely test-green

Execution profile:

- separate Codex review session
- read-only by default
- may create follow-up issues, but may not auto-launch them

Responsibilities:

- review branch diff, tests, and issue outcome
- detect shallow fixes that hide broken behavior
- recommend or create follow-up issues when needed

Outputs:

- `approved`
- `followup_required`
- `implementation_bug_found`

If review finds a real defect in the same branch and it is clearly fixable, PatchRelay may reopen or resume the implementation stage for the same root issue.

## Status and comment model

PatchRelay owns a small comment contract in Linear.

Each automated issue should have:

- one active status comment
- one stable session identifier
- one root automation identifier

Comment types:

- intake comment
- safety result comment
- implementation start/progress comment
- blocker comment
- completion comment
- review result comment

PatchRelay should update existing comments when possible rather than spamming new ones for every small event.

## State model

Internal PatchRelay state:

- `received`
- `deduped`
- `safety_pending`
- `safety_running`
- `ready_for_impl`
- `impl_running`
- `impl_blocked`
- `impl_complete`
- `review_pending`
- `review_running`
- `done`
- `ignored`
- `failed`

The internal state machine is authoritative for PatchRelay behavior. Linear states are mirrored for human visibility, not used as the sole source of truth.

## Security model

### Trust boundaries

Untrusted:

- Linear issue descriptions
- comments
- linked documents
- imported text from external systems

Trusted:

- PatchRelay config
- allowlisted repositories
- webhook secret
- local operator actions
- explicit stage policies

### Prompt injection defenses

PatchRelay must assume issue content can contain malicious instructions.

Therefore:

- no single agent should blindly treat issue text as executable instructions
- safety check runs before write-capable execution
- only structured fields extracted by PatchRelay should drive stage routing
- issue text should be passed to implementation agents as task context, not as authority
- implementation prompts should explicitly say that repo policy and system instructions override issue text
- external URLs and attached content should not be fetched automatically in v1

### Least privilege

Stage privileges should increase only when the previous stage allows it:

- intake: no model required, no repo writes
- safety: model allowed, repo read-only
- implementation: repo write access, git, tests, Linear MCP
- review: repo read-only by default, limited Linear write access for comments and follow-up issues

### Local execution safety

PatchRelay should:

- launch each session in a dedicated worktree
- enforce one active implementation session per root issue
- cap total concurrent sessions
- apply timeouts to inactive stages
- record launched process ids and `zmx` session ids

## Fork-bomb and loop prevention

This is a first-class requirement.

### Rules

- only human-created or explicitly promoted issues may auto-enter implementation
- issues created by PatchRelay must default to `manual review required`
- follow-up issues created by review must never auto-trigger implementation by default
- every issue stores `root_issue_id` and `automation_depth`
- default maximum `automation_depth` is `1`
- default maximum active child issues per root issue is small, for example `3`
- default maximum active implementation sessions per repo is small, for example `2`

### Practical policy

For v1:

- root human issue may trigger safety and implementation
- review bot may create follow-up issues
- follow-up issues stop in `Triage` or `Blocked` with a PatchRelay note
- a human must explicitly relabel or promote them before PatchRelay may continue

This avoids self-spawning chains.

## Concurrency and idempotency

PatchRelay must be safe under repeated webhooks and restarts.

Requirements:

- dedupe by Linear `webhookId`
- debounce bursts of issue updates
- only one stage runner may hold a lock for a given issue at a time
- restarting PatchRelay must not launch duplicate sessions for the same stage
- agent launches must be recorded before the process is considered active

SQLite tables should include:

- `webhook_events`
- `issues`
- `issue_runs`
- `stage_locks`
- `sessions`
- `comments`

## Operator model

PatchRelay should be operable by one developer without extra infrastructure.

Minimal operator functions:

- inspect current issue state
- retry a failed stage
- resume a stage after restart
- mark an issue manual-only
- unlock a stuck issue
- replay a stored webhook event

Do not require a full web UI in v1. A small CLI or protected local admin endpoint is enough.

## Recommended first implementation

### Stack

- TypeScript on Node.js
- SQLite with WAL mode
- small HTTP framework such as Hono, Express, or Fastify
- Caddy for TLS and external ingress
- local process spawning for `zmx`

### Non-goals for v1

- multi-tenant SaaS
- arbitrary repository support without configuration
- automatic browsing of external attachments
- fully native Linear Agent Session UX
- automatic execution of bot-created follow-up issues

## Suggested configuration

Required:

- `LINEAR_WEBHOOK_SECRET`
- `LINEAR_API_TOKEN` or OAuth credentials
- `LINEAR_WORKSPACE_ID`
- `PATCHRELAY_DB_PATH`
- `PATCHRELAY_REPO_ROOT`
- `PATCHRELAY_ALLOWED_TEAM_IDS`
- `PATCHRELAY_ALLOWED_LABELS`
- `PATCHRELAY_MAX_CONCURRENT_IMPL`
- `PATCHRELAY_MAX_AUTOMATION_DEPTH`

Optional:

- `PATCHRELAY_CADDY_FORWARDED_SECRET`
- `PATCHRELAY_WEBHOOK_PATH_SUFFIX`
- `PATCHRELAY_ADMIN_BIND`

## Open questions

- should PatchRelay use a personal token first or invest immediately in a proper internal OAuth app?
- should implementation launch on transition to `Ready`, on delegate assignment, or only on explicit PatchRelay label?
- should review create follow-up issues automatically or only draft them as comments first?
- should `zmx` session names encode issue key, repo, and stage?
- should the implementation stage always use Codex first, or should the stage runner be model-agnostic from day one?

## Recommended v1 policy decisions

- use standard signed Linear webhooks, not native Linear Agent Session APIs, for v1 simplicity
- use a dedicated PatchRelay label as the automation allow rule
- require safety check before any write-capable agent
- keep review read-only by default
- never auto-execute follow-up issues created by PatchRelay
- keep the whole service local and single-node

## Source notes

Design choices above are informed by current primary-source guidance:

- Linear recommends signed webhook verification with raw body HMAC, timestamp checking, and fast webhook responses
- Linear’s agent APIs and Agent Session UI are currently in Developer Preview
- Linear’s agent guidance expects fast acknowledgement and structured session activity when using Agent Sessions
- OpenAI recommends isolating untrusted input, using structured outputs, and hardening tool-using multi-agent workflows against prompt injection
- Anthropic’s current guidance recommends sequential multi-agent workflows only when each stage adds clear value

## Reference links

- Linear webhooks: https://linear.app/developers/webhooks
- Linear webhook SDK helper: https://linear.app/developers/sdk-webhooks
- Linear agent getting started: https://linear.app/developers/agents
- Linear agent interaction: https://linear.app/developers/agent-interaction
- Linear interaction best practices: https://linear.app/developers/agent-best-practices
- OpenAI agent safety guide: https://developers.openai.com/api/docs/guides/agent-builder-safety
- Anthropic building effective agents: https://resources.anthropic.com/hubfs/Building%20Effective%20AI%20Agents-%20Architecture%20Patterns%20and%20Implementation%20Frameworks.pdf?hsLang=en
