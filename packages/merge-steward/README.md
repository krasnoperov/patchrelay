# merge-steward

Self-hosted merge queue for bot-managed and human-managed GitHub pull requests. Merge Steward turns reviewed PRs into a tested landing train: it runs CI on the exact future `main` SHAs, validates several PRs in parallel, and fast-forwards through the green sequence as soon as it is safe.

Independent of PatchRelay. Communicates through GitHub only — PRs, reviews, checks, labels, branches. Pairs with `review-quill`; neither requires the other.

For the background story and design trade-offs, read [merge-steward: speculative integration, parallel validation, fast-forward landing](https://blog.krasnoperov.me/posts/merge-steward).

## Why this matters

The queue keeps delivery fast without pretending branch CI is enough. Each speculative branch is the cumulative queue order on top of the latest base: `main + A`, then `main + A + B`, then `main + A + B + C`. No more "CI was green yesterday, breaks on merge today" — the integration bug is caught before `main` ever sees it.

## How it works

1. A PR becomes eligible when GitHub says it is approved and its required checks are green.
2. The steward notices through webhook wakeups or startup reconcile scans, and admits the PR to the queue.
3. It builds a speculative branch — `main + PR` at the head, cumulative downstream (`main + A + B`, `main + A + B + C`).
4. CI runs on that speculative SHA.
5. Once the speculative SHA's checks are green and it is still a fast-forward from current `main`, the steward pushes that SHA to `main` immediately. It does **not** wait for `main`'s own CI to settle, and **never** pauses the queue because `main` is red — the green speculative SHA *is* the next `main`.
6. On CI failure: retry (gated on base SHA change), then evict with a durable incident record and GitHub check run.
7. PatchRelay, the `ship-pr` skill, or any agent sees the check run failure and fixes the branch; when CI passes again the PR can be re-admitted.

## Use with your own agent

For an agent that drives PRs through the queue and reacts to evictions / failing checks without running PatchRelay's full harness, install the [`ship-pr`](https://github.com/krasnoperov/patchrelay-agents) skill from the companion Claude Code marketplace:

```
/plugin marketplace add krasnoperov/patchrelay-agents
/plugin install ship-pr@patchrelay
```

The skill wraps `merge-steward pr status --wait` and `review-quill pr status --wait` into a blocking-gate workflow with stable exit codes, so the agent only wakes on terminal outcomes.

## Quick start

Prerequisites: Node.js 24+, `gh` CLI in `PATH`, `git`.

```bash
pnpm add -g merge-steward
merge-steward init https://queue.example.com
merge-steward repo attach owner/repo --base-branch main
merge-steward doctor --repo repo
merge-steward service status
merge-steward queue status --repo repo
```

- `init` writes config files and a systemd unit, then prints the webhook URL to configure in GitHub.
- You still need to install `merge-steward-webhook-secret` and `merge-steward-github-app-pem` via systemd credentials, or provide the documented environment/file fallbacks.
- `repo attach` discovers the default branch from GitHub and stores a per-repo config.
- Required checks are learned from GitHub branch protection at runtime — the steward does not keep a local copy.

Full setup (GitHub App permissions, secrets, webhook events, systemd, HTTP API): [docs/merge-steward.md](https://github.com/krasnoperov/patchrelay/blob/main/docs/merge-steward.md).

## Everyday commands

```bash
merge-steward dashboard                         # operator UI across all projects
merge-steward pr status                         # one-PR verdict (inside a git checkout)
merge-steward queue status --repo <id>          # quick text snapshot
merge-steward queue show --pr <num>             # one PR's queue events and incidents
merge-steward queue reconcile --repo <id>       # force one reconcile tick
merge-steward service logs --lines 100
```

`pr status`, `queue status`, `queue show`, and `queue reconcile` auto-resolve `--repo` and `--pr` from the current git checkout. `pr status` supports `--wait --timeout <s> --poll <s>` for blocking until a terminal state. Exit codes:

| Code | Meaning |
|-|-|
| 0 | merged / approved with green required checks |
| 2 | changes_requested / failing required checks / evicted / closed |
| 3 | still in flight (queued, preparing, validating, merging, pending) |
| 4 | `--wait` timed out |
| 1 | usage or configuration error |

## Merge gate

The real gate is:

- GitHub says the PR review state is approved
- configured required checks are green
- the steward's speculative integrated branch also passes CI

`review-quill/verdict` only matters if you include it in the repo's required checks. Branch protection is useful as defense in depth, but the steward merges by fast-forwarding `main` to the already-tested speculative SHA — not by pressing GitHub's merge button. Successful merges therefore depend on the steward App being allowed to push to the protected branch. See [docs/merge-steward.md](https://github.com/krasnoperov/patchrelay/blob/main/docs/merge-steward.md) for the full App permission set.

**`main`'s own CI is information-only.** The speculative SHA the steward tests *is* the exact tree that becomes `main`, so re-testing `main` after the push adds no signal — it only catches flakiness or out-of-band changes (direct pushes, hotfixes). The queue therefore **ignores `main`'s CI entirely** for advancement: it does not gate landing on `main` being green, does not wait for `main` CI before the next landing, and is never "paused" by a red `main`. A red `main` with a green speculative SHA simply means the red was flaky or is fixed by landing — so the steward lands. Use `main`'s CI as a project-health canary, not a queue control.

## Interaction with PatchRelay

Independent services, GitHub as the shared bus:

1. PatchRelay moves an issue to `awaiting_queue` when the linked PR is approved and green, and may add the configured queue label as an admission nudge.
2. The steward admits from fresh GitHub truth, lands the PR, or evicts and creates the eviction check run (default `merge-steward/queue`).
3. PatchRelay watches for that check run failure and triggers `queue_repair`.
4. After repair, PatchRelay pushes a new head; the steward re-admits only after the new head is approved and green.

Neither service calls the other's API.

## Reference

- [merge-steward: speculative integration, parallel validation, fast-forward landing](https://blog.krasnoperov.me/posts/merge-steward) — background essay and design trade-offs
- [docs/merge-steward.md](https://github.com/krasnoperov/patchrelay/blob/main/docs/merge-steward.md) — operator reference: GitHub App permissions, secrets, webhook, repo config, full CLI, HTTP API, queue state machine, systemd, troubleshooting
- [docs/merge-queue.md](https://github.com/krasnoperov/patchrelay/blob/main/docs/merge-queue.md) — the two-service delivery story
- [docs/github-queue-contract.md](https://github.com/krasnoperov/patchrelay/blob/main/docs/github-queue-contract.md) — shared GitHub artifacts
- [docs/design-docs/merge-steward.md](https://github.com/krasnoperov/patchrelay/blob/main/docs/design-docs/merge-steward.md) — design rationale
- [README.md](https://github.com/krasnoperov/patchrelay/blob/main/README.md) — the three-service stack overview
