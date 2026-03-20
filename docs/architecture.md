# PatchRelay Architecture

## What It Does

PatchRelay connects Linear issue delegation to Codex worktrees. When an issue is delegated to PatchRelay and moved to a workflow state (e.g. Start), PatchRelay:

1. Creates a git worktree and branch for the issue
2. Starts a Codex thread with the workflow instructions
3. Updates Linear state as the stage progresses
4. Parses the stage result and auto-transitions to the next stage
5. Repeats until the issue reaches Done or Human Needed

## Core Modules

Three modules handle everything:

- **webhook-handler.ts** - receives Linear webhooks, resolves project, upserts issue, sets desired stage, delivers comments/prompts to active Codex turns
- **stage-executor.ts** - launches Codex turns, handles completion notifications, parses handoffs, manages automatic transitions, runs startup reconciliation
- **db.ts** - unified SQLite database with `issues` and `runs` tables plus direct query functions

## Database

4 core tables + 3 auth tables:

- **issues** - all issue state in one row (project, Linear metadata, desired stage, workspace path, active run, lifecycle status)
- **runs** - one row per stage execution (stage, status, thread/turn IDs, report)
- **webhook_events** - idempotent webhook intake
- **run_thread_events** - optional extended Codex notification history

Auth tables (linear_installations, project_installations, oauth_states) are unchanged.

## Request Flow

1. Linear webhook arrives → signature verified → deduplicated → enqueued
2. Webhook handler resolves project, checks delegation and trust, upserts issue, sets desired stage
3. Stage executor claims the run atomically, creates worktree, starts Codex thread+turn
4. On turn/completed: reads thread, builds report, finishes run, tries automatic transition
5. Transition: parses "Next stage:" from output, or uses workflow default, or routes to Human Needed

## Automatic Transitions

After a stage completes, PatchRelay checks:
- Is the issue still delegated to PatchRelay?
- Is there already a newer desired stage?
- Did the Linear state move to a terminal state (Done, Cancelled)?

If all clear, it parses the stage result for "Next stage: X" or falls back to the workflow's configured default transition (development→review→deploy→done).

## Reconciliation

On startup and periodically, PatchRelay checks running runs:
- Thread completed → complete the run and advance
- Thread interrupted → restart with a recovery prompt
- Thread missing → fail the run
- Linear in terminal state → release the run

## Kept Periphery

These modules are unchanged: codex-app-server, linear-client, config, worktree-manager, webhooks, http, token-crypto, project-resolution, workflow-policy, stage-launch, stage-handoff, stage-reporting, stage-failure, linear-workflow, agent-session-plan, agent-session-presentation, public-agent-session-status, service-queue, operator-feed, logging, utils.
