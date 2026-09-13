# GitHub Queue Contract

PatchRelay, review-quill, and merge-steward are independent reconcilers.
GitHub is their only protocol boundary. Webhooks are wakeups; every decision is
re-derived from current GitHub truth after a webhook, periodic scan, or restart.

No label, comment, command string, or direct service API call is part of the
control protocol.

## Shared facts

- PR number, base branch, head branch, and head SHA
- PR open/draft/merged state
- GitHub review state and reviewed head SHA
- required check state bound to a commit SHA
- candidate ref and its exact SHA
- Git ancestry between prospective base, approved head, and candidate
- `patch_id` for feature-review carry-forward only

## Named GitHub artifacts

| Artifact | Name | Writer | Readers |
|-|-|-|-|
| Integration workspace | `merge-steward/<base>/pr-<number>` | Merge Steward; PatchRelay by non-force push | All services, CI |
| Feature review | Ordinary GitHub PR review | Review Quill or human | PatchRelay, Merge Steward |
| Integration review | `review-quill/integration` check | Review Quill | PatchRelay, Merge Steward |
| Candidate CI | Repository-required checks on candidate SHA | CI | PatchRelay, Merge Steward |

Labels may still exist for presentation or human filtering, but removing or
losing them cannot admit, block, repair, reorder, or merge a PR.

## Candidate ref contract

For PR `104` targeting `main`:

```text
refs/heads/merge-steward/main/pr-104
```

The PR number makes the ref self-describing; consumers do not need Merge
Steward's internal queue-entry identity.

### Candidate construction

1. Merge Steward resolves the prospective base from current `main` and prior
   train candidates.
2. If that base is an ancestor of the approved PR head, the approved head is
   the exact candidate and no synthetic ref is required unless that candidate
   later needs integration-only test repair.
3. Otherwise Merge Steward creates the workspace ref.
4. On a clean merge, the ref points to a commit containing both the prospective
   base and approved head.
5. On conflict, the ref remains at the prospective base. Merge Steward does not
   trigger candidate CI because the approved head is not yet in the ref.

### Ownership and concurrency

- Merge Steward may create, reset, and delete candidate refs.
- PatchRelay may fetch a candidate ref, integrate the frozen approved head,
  commit conflict or test repairs, and make a non-force push.
- PatchRelay must never force-push a candidate ref.
- A non-fast-forward rejection means the prospective base changed. PatchRelay
  discards the stale attempt and reconciles from the new GitHub state.
- PatchRelay must never push an integration repair to the PR branch.
- For a tracked PR, any effective approval on its exact current head and green
  branch CI authorize PatchRelay to repair this candidate ref even without
  Linear delegation. This authority does not extend to feature work.

## Derived action table

| GitHub truth | Derived action |
|-|-|
| Open PR, feature approval and required branch checks green, no queue entry | Merge Steward admits it. |
| Admitted PR, no current candidate | Merge Steward creates or selects one. |
| Workspace exists but approved head is not its ancestor | PatchRelay runs `integration_repair` on that workspace. |
| Candidate contains approved head and checks are pending | Wait. |
| Candidate contains approved head and required checks are settled red | PatchRelay diagnoses and repairs the candidate; an infra-only failure may rerun on the same SHA. |
| PatchRelay-authored candidate lacks `review-quill/integration` on its SHA | Review Quill performs narrow integration review. |
| Integration review fails | Candidate is not landable; return to feature implementation and full feature review. |
| Candidate is green, integration review is satisfied, predecessors landed | Merge Steward revalidates and lands that exact SHA. |
| Candidate no longer descends from its prospective base | Merge Steward resets/rebuilds it; preserve feature approval. |
| PR head changes | Delete stale candidates and evaluate the new feature head through ordinary feature review. |

Services may retain local databases for queue order, retry budgets, issue UX,
and audit history. Those databases are not cross-service messages and must be
recoverable by reconciling with GitHub truth.

For an exact-head candidate with a settled landing-policy failure, Merge Steward
first publishes the workspace ref at that approved head. The same table then
applies: PatchRelay adds repair commits only to the workspace.

## Review contract

### Feature review

Review Quill publishes an ordinary GitHub review on the PR head. The feature
branch may iterate until it has both approval and green branch CI. Once admitted
to integration, the approved head is frozen.

The frozen baseline may be established by any effective GitHub approval on the
exact current head, including a human approval; it is not restricted to a
Review Quill-authored approval. Approval on an older head is never reusable.

`patch_id` is computed as:

```text
git diff $(git merge-base <base> <head>)..<head> \
  | git patch-id --stable \
  | awk '{print $1}'
```

An identical patch may reuse the prior feature verdict. A changed patch needs a
new feature review. A moving `main` does not itself create a new feature-review
round; its effect is evaluated on the integration candidate.

### Integration review

Review Quill inspects only a candidate changed by PatchRelay. It compares the
approved feature, prospective-base changes, conflict/test repair, and resulting
candidate. It publishes `review-quill/integration` on the candidate SHA.

`success` means the approved implementation survived integration. `failure`
means the repair materially changed its API, behavior, acceptance criteria,
security, billing, persistence, permissions, schema, or feature-owned test
expectations. That is the only review result that sends work back to the feature
track.

## CI contract

Checks are reusable only when all of these remain equal:

- exact commit SHA;
- required-check policy;
- trusted check producer.

The branch name or event that first caused the run is irrelevant. Consequently,
an integration candidate already green on its exact SHA is not tested again
after that SHA becomes `main`.

## Speculative train contract

Merge Steward builds cumulative candidates up to configured speculative depth.
If candidate B in `A -> B -> C` needs repair, B stays ordered in the train. C
may finish work already running but cannot land first. A changed B invalidates
C; an unresolved B conflict pauses C because no prospective base for C exists.

The ordinary response to candidate conflict or test failure is repair, not
eviction. Terminal removal is reserved for explicit dequeue, product or policy
ambiguity, exhausted repair budget, or integration review proving the feature
must change.

## Required GitHub events

PatchRelay, Review Quill, and Merge Steward subscribe to the events relevant to
their facts:

- `pull_request`
- `pull_request_review`
- `check_suite` and `check_run`
- `push`, including candidate refs and the base branch

Missing delivery is recovered by periodic/startup reconciliation.

## Replaceability

Any replacement author, reviewer, lander, or CI provider is compatible if it
produces and consumes the same GitHub facts. It does not need access to another
service's private database or API.
