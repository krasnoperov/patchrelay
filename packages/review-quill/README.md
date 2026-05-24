# review-quill

Self-hosted GitHub PR review bot. For each new PR head, it materializes a throwaway checkout at the exact SHA, runs a Codex review pass with your repo's review docs, and publishes a normal PR review under its GitHub App identity.

Independent of PatchRelay. Pairs with `merge-steward`; neither requires the other.

For the background story and design trade-offs, read [review-quill: a strict reviewer for your coding agent](https://blog.krasnoperov.me/posts/review-quill).

## What it does

For each eligible PR head:

1. Detects that a new reviewable PR head exists.
2. Materializes an ephemeral local checkout at that exact SHA.
3. Builds a curated diff against the PR base branch.
4. Loads repo review guidance plus universal `AGENTS.md` (`REVIEW_WORKFLOW.md`, `AGENTS.md` by default), plus local Markdown docs explicitly referenced by the PR title/body.
5. Carries forward a prior approved verdict when the patch identity is unchanged.
6. Runs a review pass through `codex app-server` when a fresh review is needed.
7. Publishes an ordinary GitHub `APPROVE` or `REQUEST_CHANGES` review.
8. Supersedes stale attempts and interrupts running review turns when a newer PR head lands first.

The review runs against the real working tree at that SHA, not the GitHub files API.

The default Codex sandbox mode is `danger-full-access` because many systemd hosts cannot run Codex's bubblewrap networking inside `read-only` / `workspace-write` modes. The reviewer still works in a throwaway checkout and review-quill publishes only through the GitHub App; it does not commit or push.

By default, a PR becomes eligible for review as soon as its branch head updates. Set `waitForGreenChecks: true` per-repo to gate on configured checks first.

Review execution concurrency defaults to 4 because reviews share one Codex app-server and one git cache per repo. Tune `reconciliation.maxConcurrentReviews` after watching local load.

## Use with your own agent

For an agent that iterates on review feedback in real time without running PatchRelay's full harness, install the [`ship-pr`](https://github.com/krasnoperov/patchrelay-agents) skill from the companion Claude Code marketplace:

```
/plugin marketplace add krasnoperov/patchrelay-agents
/plugin install ship-pr@patchrelay
```

The skill wraps `review-quill pr status --wait` and `merge-steward pr status --wait` into a blocking-gate workflow with stable exit codes, so the agent only wakes on terminal outcomes (approved / requested-changes / merged / failing-checks).

## Quick start

```bash
pnpm add -g review-quill
review-quill init https://patchrelay.example.com/review
# Fill service.env and install the webhook secret + GitHub App private key.
review-quill repo attach owner/repo
review-quill doctor --repo repo
review-quill service status
review-quill dashboard
```

`init` writes config files and a systemd unit, then prints the webhook URL to configure in GitHub. You still need to install `review-quill-webhook-secret` and `review-quill-github-app-pem` via systemd credentials, or provide the documented environment/file fallbacks. `repo attach` is idempotent: it auto-discovers the default branch and required checks, stores repo-local review doc paths, and reloads the service.

If you want machine review to count toward merge admission, include `review-quill/verdict` in the repository's required checks.

## Everyday commands

```bash
review-quill dashboard                          # live operator UI
review-quill pr status                          # one-PR verdict (inside a git checkout)
review-quill attempts --pr <num>                # review history
review-quill transcript --pr <num>              # visible Codex thread for the latest attempt
review-quill diff --repo <id>                   # debug: what the reviewer would see
review-quill service logs --lines 100
```

`pr status`, `attempts`, `transcript`, and `transcript-source` auto-resolve `--repo` and `--pr` from the current git checkout. `pr status` supports `--wait --timeout <s> --poll <s>` for blocking until a review attempt terminates. Exit codes:

| Code | Meaning |
|-|-|
| 0 | approved / skipped |
| 2 | declined (changes requested) / errored / cancelled |
| 3 | queued / running / no attempt yet |
| 4 | `--wait` timed out |
| 1 | usage or configuration error |

## Relationship to PatchRelay and Merge Steward

Three services, distinct ownership, GitHub as the shared bus:

- `patchrelay` — delegated implementation, branch upkeep, issue/worktree orchestration
- `review-quill` — PR review publication
- `merge-steward` — queue admission, speculative validation, landing

## Reference

- [review-quill: a strict reviewer for your coding agent](https://blog.krasnoperov.me/posts/review-quill) — background essay and design trade-offs
- [docs/review-quill.md](https://github.com/krasnoperov/patchrelay/blob/main/docs/review-quill.md) — operator reference: GitHub App permissions, public ingress, review context pipeline, full CLI surface, troubleshooting
- [docs/prompting.md](https://github.com/krasnoperov/patchrelay/blob/main/docs/prompting.md) — how the review prompt is composed
- [docs/design-docs/review-quill.md](https://github.com/krasnoperov/patchrelay/blob/main/docs/design-docs/review-quill.md) — design rationale
- [README.md](https://github.com/krasnoperov/patchrelay/blob/main/README.md) — the three-service stack overview
