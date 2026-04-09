# Prompting

PatchRelay and Review Quill both follow the same simple rule:

- keep the always-on harness prompt small
- keep `AGENTS.md` short and navigational
- keep repo-specific workflow guidance in versioned repo files
- let additive prompt layers extend the default instead of replacing it

## Mental Models

PatchRelay is an implementation agent scaffold:

- understand the delegated task
- stay in scope
- use repo docs as source of truth
- validate in the real worktree
- publish correctly

Review Quill is a review agent scaffold:

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

Those are the canonical places to review or change the built-in prompt structure.

## Repo Guidance

Repo-local workflow files still carry most of the domain-specific guidance:

- `IMPLEMENTATION_WORKFLOW.md`
- `REVIEW_WORKFLOW.md`
- `AGENTS.md`

Recommended split:

- `AGENTS.md`: short repo map and non-negotiables
- workflow files: task-specific agent behavior
- `docs/`: deeper architecture and product context

## Layering

PatchRelay prompt order:

1. built-in sections from `src/prompting/patchrelay.ts`
2. install-level prompt fragments from `patchrelay.json`
3. repo-level prompt fragments from `.patchrelay/patchrelay.json`
4. runtime context from the active issue/run
5. workflow guidance from the repo

Review Quill prompt order:

1. built-in sections from `packages/review-quill/src/prompt-builder/render.ts`
2. install-level prompt fragments from `review-quill.json`
3. repo-level prompt fragments from `.patchrelay/review-quill.json`
4. PR and diff context
5. repo guidance docs

## Install-Level Customization

PatchRelay service config supports:

```json
{
  "prompting": {
    "default": {
      "prepend_files": ["./prompts/prelude.md"],
      "append_files": ["./prompts/appendix.md"],
      "replace_sections": {
        "publication-contract": "./prompts/publication.md"
      }
    },
    "by_run_type": {
      "review_fix": {
        "append_files": ["./prompts/review-fix.md"]
      }
    }
  }
}
```

Review Quill service config supports:

```json
{
  "prompting": {
    "prependFiles": ["./prompts/prelude.md"],
    "appendFiles": ["./prompts/appendix.md"],
    "replaceSections": {
      "grounding": "./prompts/grounding.md"
    }
  }
}
```

Prompt fragment paths are resolved relative to the service config file.

## Repo-Level Customization

PatchRelay repo-local prompt config:

```json
{
  "version": 1,
  "prompt": {
    "default": {
      "appendFiles": [".patchrelay/prompts/implementation-notes.md"]
    },
    "byRunType": {
      "ci_repair": {
        "appendFiles": [".patchrelay/prompts/ci-repair.md"]
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
    "appendFiles": [".patchrelay/prompts/review-notes.md"],
    "replaceSections": {
      "review-rubric": ".patchrelay/prompts/review-rubric.md"
    }
  }
}
```

Prompt fragment paths are resolved relative to the repo root.

## Section Replacement

PatchRelay section ids:

- `header`
- `follow-up-turn`
- `task-objective`
- `scope-discipline`
- `human-context`
- `reactive-context`
- `workflow-guidance`
- `publication-contract`

Review Quill section ids:

- `preamble`
- `output-contract`
- `review-rubric`
- `grounding`
- `pull-request`
- `diff-context`
- `repo-guidance`
- `prior-review-claims`

Unknown section ids are ignored and logged as warnings.

## Recommended Usage

Prefer this order:

1. keep `AGENTS.md` short
2. put durable repo behavior in workflow files and docs
3. use prepend/append fragments for extra local context
4. use section replacement only for narrow policy changes
5. replace the full prompt only if the additive model is genuinely insufficient

The default prompts are meant to be usable without tuning. The customization layers exist so teams can stay minimal by default and still bend the harness when they need to.
