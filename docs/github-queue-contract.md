# GitHub Queue Contract

PatchRelay, review-quill, and merge-steward are three intentionally decoupled services. GitHub is the protocol boundary between all of them.

This document is the contract for that boundary. For the mental model behind it (three roles, four primitives, the carry-forward rule, the eviction rule) see [concepts.md](./concepts.md).

## Shared Primitives

- Repository: `repoFullName`
- Base branch: `baseBranch`
- Pull request identity: `prNumber`, branch name, `headSha`, `baseSha`
- Review state: approved, changes requested, commented
- Check state: passed, failed, pending
- Merge state: open, closed, merged
- **Change identity**: `patch_id` (always) and `integration_tree_id` (in integration-tree review mode). See [Identity algorithms](#identity-algorithms) below.

## Shared Control Artifacts

The bus carries seven named artifacts. All default to merge-steward / review-quill / patchrelay conventions but are configurable per project so any role can be replaced by a generic alternative without breaking the others.

| Artifact | Default name | Writer | Readers |
|-|-|-|-|
| Eviction check_run | `merge-steward/queue` | Lander | Author |
| Spec-ready check_run | `merge-steward/spec-ready` | Lander | Reviewer |
| Spec branch ref | `mq-spec-<entry-id>` | Lander | Reviewer, operators |
| No-cache PR label | `review:no-cache` | Author / human | Reviewer |
| Queued-for-deploy Linear sub-label | `queued-for-deploy` | Author | Operators |
| Queue-testing PR label | `queue:testing` | Lander | Author, operators |
| Queue-merging PR label | `queue:merging` | Lander | Author, operators |

Defaults preserve current behaviour bit-for-bit. Each service exposes its own configuration field for overriding the names — see [Configurable names per service](#configurable-names-per-service) below.

### Eviction check_run (Lander → Author)

Merge Steward emits this on queue eviction. PatchRelay interprets it as a queue-repair request rather than ordinary CI failure. The check carries structured incident detail in `output.text` plus an incident details URL so PatchRelay preserves richer repair context.

### Spec-ready check_run (Lander → Reviewer)

Merge Steward creates this on the PR head after pushing the speculative branch (`reconciler-prepare.ts`). It announces *"the integration tree for this PR is at SHA X on branch Y"*. review-quill subscribes to this name when running in `integration_tree` mode and uses the spec SHA as the integration target. Pure GitHub bus; no service-to-service call.

| Field | Value |
|-|-|
| `name` | `merge-steward/spec-ready` (configurable) |
| `status` | `completed` |
| `conclusion` | `neutral` (it's an event, not a verdict) |
| `output.summary` | Spec SHA + spec branch ref |
| `target_url` | Link to the spec branch's commit page |

### No-cache PR label (Author → Reviewer)

A PR carrying this label opts out of carry-forward — review-quill always runs a fresh review even when the patch is unchanged. Useful for release / changelog PRs that need a fresh body rendering.

### Queued-for-deploy Linear sub-label (Author → operators)

When a project's Linear workflow does not include an In Deploy state, PatchRelay leaves the issue in In Review and adds this label so operators can distinguish *"in review, awaiting verdict"* from *"in review, queued for landing."* Removed when the issue leaves the deploy fallback (Done, eviction back to In Progress, or moves to a real In Deploy state).

### Queue sub-state PR labels (Lander → Author, operators)

Merge Steward keeps these two labels in sync with a PR's live position in the queue, so the queue phase is visible on the GitHub PR itself and readable by PatchRelay for its Linear "In Merge Queue" status. They are mutually exclusive and edge-triggered (applied/cleared only on phase change), and cleared once the entry leaves the active queue (merged, evicted, or dequeued).

| Label | Set when | Meaning |
|-|-|-|
| `queue:testing` | entry is `validating` | Spec CI is running / awaiting its turn |
| `queue:merging` | entry is `merging` | Head of queue, merge in progress |

The Lander never touches any other label, so the admission label (`queue`), priority label (`queue:priority`), and human-applied labels are left intact.

## Ownership

- PatchRelay owns:
  - branch implementation
  - review fixes
  - branch-local CI repair
  - queue repair after steward eviction
  - Linear-facing operator and session UX

- Merge Steward owns:
  - queue admission
  - branch freshness
  - validation retries
  - merge execution
  - eviction classification and incident creation

## Required GitHub Events

- PatchRelay:
  - `pull_request`
  - `pull_request_review`
  - `check_suite`
  - `check_run`
  - `push`

- Merge Steward:
  - `pull_request`
  - `pull_request_review`
  - `check_suite`
  - `push`

## Failure Contract

- Ordinary branch CI failure:
  - produced by normal PR checks
  - PatchRelay routes to `ci_repair`

- Requested changes:
  - produced by a GitHub pull request review whose state is `CHANGES_REQUESTED`
  - PatchRelay records the blocking review head SHA and routes delegated issues to `review_fix`
  - before launching every repair, PatchRelay refreshes review context from GitHub directly: latest requested-changes review id, review body, inline review comments, review commit SHA, current PR head SHA, and reviewer login when available
  - cached Linear or prior-run context may enrich the prompt, but it cannot skip the GitHub refresh; if the refresh is degraded, the repair prompt must say so before launch
  - the repair must push a new remote PR head before PatchRelay can return the issue to review or queue
  - the Linear completion response reports the review round, resulting head when known, and structured addressed/deferred/not-applicable sections
  - if the run finishes while the remote PR head is still the blocking review head, PatchRelay must fail the run and surface a system failure instead of handing the same SHA back to the reviewer

- Queue eviction:
  - produced by Merge Steward as the configured eviction check run
  - PatchRelay routes to `queue_repair`
  - PatchRelay persists queue-failure provenance so reconciliation can preserve the distinction after webhook delivery
  - the eviction check run should carry structured incident detail in `output.text` plus an incident details URL so PatchRelay can preserve richer repair context

## Observability Contract

- PatchRelay should expose:
  - configured eviction check name
  - last observed queue/failure signal

- Merge Steward should expose:
  - incident detail for evicted entries
  - emitted eviction check run name
  - current required checks / admission facts from GitHub truth

## Identity algorithms

A change has at most two identity hashes. Any service implementing the pipelines below exactly produces interoperable identities — same inputs, same byte sequence, same hash. This is the spec, like RFC 7519 (JWT). No reference implementation, no shared package required for interop.

```
PATCH_ID(branch, base) :=
  git diff $(git merge-base <base> <branch>)..<branch> \
    | git patch-id --stable \
    | awk '{print $1}'

INTEGRATION_TREE_ID(base, head) :=
  # Auto form (preferred — git resolves the merge-base):
  git merge-tree --write-tree <base-ref-or-sha> <head-ref-or-sha>

  # Or, when the merge-base must be supplied explicitly:
  git merge-tree --write-tree --merge-base <merge-base-sha> <base> <head>
```

Notes:

- `git patch-id --stable` (not bare `git patch-id`) — the `--stable` flag canonicalises per-file order so commit reorders within a range produce the same id.
- The output of `merge-tree --write-tree` is a **tree object id**, not a commit SHA. Comparisons must use `git rev-parse <commit>^{tree}` or a separately stored tree id.
- Non-zero exit from `git merge-tree` means *cannot integrate* and is a real conflict signal, not an error condition.
- `<base>` for `PATCH_ID` is the PR's base ref as GitHub reports it. For a stacked PR, that's the parent PR's branch — not always main.

## Review carry-forward

review-quill caches approved verdicts so a head SHA change that does not change the patch (rebase onto fresh main, force-push of the same content, etc.) does not trigger a fresh review run.

Two review surface modes, coupled to two cache shapes:

| Mode | Reviewer reads | Cache key | Default? |
|-|-|-|-|
| `head` | The PR head's diff against its base | `patch_id` only | Yes |
| `integration_tree` | The synthetic merged tree (`git merge-tree --write-tree base head`) | `(patch_id, integration_tree_id)` | Opt-in per repo |

Set `reviewSurfaceMode: "integration_tree"` in the per-repo review-quill config to opt in. In integration-tree mode, materialisation builds a synthetic merge commit (`git commit-tree tree -p base -p head`) and detaches the worktree to it, so the reviewer's file reads see what would actually land. A real merge-tree conflict produces a `cannot_integrate` decline rather than throwing.

Mixing modes with the wrong cache key produces incorrect carry-forward, so `review_surface_mode` is recorded on every `review_attempts` row and the lookup filters on it.

A PR carrying the configured no-cache label (default `review:no-cache`) is always re-reviewed even when the patch is unchanged.

Carry-forward only fires for stored verdicts that include the rendered review body and event. Rows from before the carry-forward migration have NULL bodies and naturally fall through to a fresh review (rollout safety).

## Configurable names per service

Each service exposes its own configuration shape rather than a single shared field, so configuration aligns with each service's existing convention. Defaults across services agree byte-for-byte; overriding a name on one side requires the same override on the other.

**patchrelay** — under `github.*` in `workflow-types.ts`:

```ts
github: {
  mergeQueueCheckName?: string;     // default: "merge-steward/queue"
  specReadyCheckName?: string;      // default: "merge-steward/spec-ready"
  specBranchPattern?: string;       // default: "mq-spec-*"
  noCacheLabel?: string;            // default: "review:no-cache"
  queuedForDeployLabel?: string;    // default: "queued-for-deploy"
}
```

Resolved through `resolveMergeQueueProtocol()` (`src/merge-queue-protocol.ts`); internal code reads the resolver, never `project.github.*` directly.

**review-quill** — per-repository config (`packages/review-quill/src/types.ts`):

```ts
specReadyCheckName?: string;      // for spec-subscription in integration_tree mode
specBranchPattern?: string;
noCacheLabel?: string;
reviewSurfaceMode?: "head" | "integration_tree";   // default: "head"
```

review-quill does not need the eviction name or queued-for-deploy label.

**merge-steward** — flat config (`packages/merge-steward/src/types.ts`):

```ts
evictionCheckName?: string;       // default: "merge-steward/queue"
specReadyCheckName?: string;      // default: "merge-steward/spec-ready"
specBranchPrefix?: string;        // default: "mq-spec-" (the prefix; pattern form is "mq-spec-*")
queueTestingLabel?: string;       // default: "queue:testing"
queueMergingLabel?: string;       // default: "queue:merging"
```

### What this unlocks

- **Replace the Lander with Mergify.** Set `evictionCheckName: "mergify/queue"`, `specBranchPattern: "mergify/merge-queue/*"`. PatchRelay reacts to Mergify's eviction; review-quill watches Mergify's queue branches. No code changes.
- **Replace the Reviewer with Copilot Code Review.** Turn off review-quill. Merge-steward and patchrelay don't notice — they read GitHub's `prReviewState`, which any reviewer populates.
- **Replace the Author with a human.** PatchRelay isn't running. Merge-steward and review-quill operate on the human-authored PR normally; only the Linear status sync goes missing (a patchrelay-specific feature).
