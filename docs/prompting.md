# Prompting

PatchRelay and Review Quill use the same simple rule:

- keep the built-in harness prompt small
- keep durable harness rules in long-lived instructions
- keep `AGENTS.md` short and navigational
- keep durable repo guidance in workflow docs
- use one extra instructions file only when the defaults need a local policy overlay

## Mental Models

PatchRelay is an implementation scaffold:

- keep stable PatchRelay policy in Codex `developerInstructions`
- understand the delegated task
- stay in scope
- use repo docs as source of truth
- validate in the real worktree
- publish correctly

Review Quill is a review scaffold:

- review the current head only
- ground claims in the current diff
- flag only high-signal issues
- separate blocking issues from nits
- return a strict structured verdict

## Source Locations

PatchRelay default prompt builder:

- `src/prompting/patchrelay.ts`

Review Quill default prompt builder:

- `packages/review-quill/src/prompt-builder/render.ts`

Those are the canonical places to inspect or change the built-in prompt structure.

## Repo Guidance

The normal customization path is still repo docs:

- `AGENTS.md`
- `IMPLEMENTATION_WORKFLOW.md`
- `REVIEW_WORKFLOW.md`

Recommended split:

- `AGENTS.md`: short repo map and non-negotiables
- workflow files: task-specific agent behavior
- `docs/`: deeper architecture and product context

## Layering

PatchRelay instruction order:

1. Codex `developerInstructions`
2. built-in per-turn scaffold from `src/prompting/patchrelay.ts`
3. install-level prompt config from `patchrelay.json`
4. repo-level prompt config from `.patchrelay/patchrelay.json`
5. runtime issue/run context
6. workflow file pointer from the repo

Review Quill prompt order:

1. built-in sections from `packages/review-quill/src/prompt-builder/render.ts`
2. install-level prompt config from `review-quill.json`
3. repo-level prompt config from `.patchrelay/review-quill.json`
4. PR and diff context
5. repo guidance docs

## PatchRelay Shape

PatchRelay now splits stable policy from volatile task context.

Stable harness behavior lives in Codex `developerInstructions`, including:

- stay in scope
- publish code-delivery work before stopping
- repair on the existing PR branch
- brief reviewer-minded self-review before publishing

The per-turn PatchRelay prompt is intentionally lean and usually contains only:

- header (`Issue`, `Title`, `Branch`, `PR`)
- `## Task Objective`
- `## Constraints`
- `## Current Context` when needed
- `## Workflow`
- `## Publish`

Workflow docs are referenced, not inlined. The built-in prompt points the agent at `IMPLEMENTATION_WORKFLOW.md` or `REVIEW_WORKFLOW.md` instead of copying those files into every turn.

## Install-Level Customization

PatchRelay service config supports:

```json
{
  "prompting": {
    "extra_instructions_file": "./prompts/local-policy.md",
    "replace_sections": {
      "publication-contract": "./prompts/publication.md"
    },
    "by_run_type": {
      "review_fix": {
        "extra_instructions_file": "./prompts/review-fix.md"
      }
    }
  }
}
```

Review Quill service config supports:

```json
{
  "prompting": {
    "extra_instructions_file": "./prompts/review-policy.md",
    "replace_sections": {
      "review-rubric": "./prompts/review-rubric.md"
    }
  }
}
```

Paths are resolved relative to the service config file.

## Repo-Level Customization

PatchRelay repo-local prompt config:

```json
{
  "version": 1,
  "prompt": {
    "extraInstructionsFile": ".patchrelay/prompts/local-policy.md",
    "replaceSections": {
      "publication-contract": ".patchrelay/prompts/publication.md"
    },
    "byRunType": {
      "review_fix": {
        "extraInstructionsFile": ".patchrelay/prompts/review-fix.md"
      }
    }
  }
}
```

Review Quill repo-local prompt config:

```json
{
  "version": 1,
  "prompt": {
    "extraInstructionsFile": ".patchrelay/prompts/review-policy.md",
    "replaceSections": {
      "review-rubric": ".patchrelay/prompts/review-rubric.md"
    }
  }
}
```

Paths are resolved relative to the repo root.

## Replaceable Sections

PatchRelay allows replacing only these policy sections:

- `scope-discipline`
- `workflow-guidance`
- `publication-contract`

These ids are stable compatibility ids for prompt overlays. They do not necessarily match the visible section headings exactly.

Review Quill allows replacing only:

- `review-rubric`

Unknown section ids are ignored and logged as warnings. Known but non-overridable sections are also ignored and logged.

## Recommended Usage

Prefer this order:

1. keep `AGENTS.md` short
2. put durable repo behavior in workflow files and docs
3. use one extra instructions file for local policy overlays
4. use section replacement only for narrow policy changes
5. use hooks for dynamic/computed context

The default prompts are meant to work without tuning. Prompt config exists as a small escape hatch, not as a second documentation system.

If you need a durable global rule for all PatchRelay runs, prefer `runner.codex.developer_instructions`.
PatchRelay appends local developer instructions under a separate heading rather than replacing the built-in harness rules.

## No-PR Completion Check

PatchRelay does not use prompt-time delivery-mode inference.

The main work prompt always assumes the agent should do the task normally and publish a PR when code delivery is the natural outcome. If the run ends without a linked PR, PatchRelay performs a separate forked `completion check`.

That completion check is intentionally secondary and read-only:

- it runs in a dedicated read-only fork
- it must not run commands, call tools, or edit files
- it exists only to decide the next step after a no-PR outcome

The completion-check prompt is JSON-only and must return exactly one object with:

- `outcome`
- `summary`
- `question` when `outcome = "needs_input"`
- optional `why`
- optional `recommendedReply`

Allowed `outcome` values are:

- `continue`
- `needs_input`
- `done`
- `failed`

This keeps the main task prompt simple and moves no-PR reasoning into one explicit post-task step.
