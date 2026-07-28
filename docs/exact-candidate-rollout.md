# Exact-candidate rollout evidence

This document records the production-derived replay, safety comparison, rollout
procedure, and rollback procedure for the exact-candidate merge model. Snapshot:
2026-07-28.

## Invariants

Merge Steward resolves one immutable candidate for each dependency-ready PR:

1. If the prospective base is an ancestor of the PR head, the candidate is the
   exact head SHA.
2. Otherwise the candidate is a synthetic integration commit whose first
   parent is the prospective base and whose second parent includes the PR head.
3. Checks authorize only that candidate SHA. Named required checks also match
   their policy-declared GitHub App when GitHub exposes one.
4. Immediately before a normal non-force push, Merge Steward refreshes current
   main, PR head, approval, policy, checks, and ancestry.
5. Stack dependencies override priority. Failure blocks only the affected
   dependency closure.

`main` never advances to an equivalent tree, a mutable ref, or a SHA whose
current policy proof is missing or ambiguous.

## Production history corpus

The local production Merge Steward databases contained 4,493 queue attempts
across seven repositories:

| Measure | Count |
|-|-:|
| Merged attempts | 4,219 |
| Evicted attempts | 266 |
| Dequeued attempts | 8 |
| Attempts with flaky CI reruns | 66 |
| Attempts with retry state | 377 |
| Priority attempts | 29 |
| Persisted downstream candidates | 27 |

This corpus supplies real evidence for singles, independent queues, conflicts,
CI failures and flakes, priority movement, retries, and cumulative downstream
validation. The permanent stacked-review regression is UserTold PR #907: its
child change is six files, while the obsolete diff-to-main surface exposed
parent changes and produced unrelated review findings.

The automated replay maps those observed classes to:

| Production class | Regression coverage |
|-|-|
| Single and independent PRs | `serial-happy.test.ts`, `exact-candidate.test.ts` |
| Three-plus and interleaved stacks | `stack-candidate-lifecycle.test.ts` |
| Conflicts and failed parents | `conflict-chain.test.ts`, `non-spinning-retry.test.ts` |
| CI failures and flakes | `ci-recovery.test.ts`, `flaky-tolerance.test.ts` |
| Priority movement | `stack-candidate-lifecycle.test.ts`, property suite |
| Force-push and base movement | `spec-edge-cases.test.ts`, `revalidation.test.ts` |
| Policy movement and wrong App | `policy-refresh.test.ts`, `check-policy.test.ts` |
| Push races, protection, auth, timeout | `exact-candidate.test.ts`, `reconciler-merge.test.ts` |
| Persisted phase recovery | `recovery-exhaustive.test.ts`, `sqlite-crash-recovery.test.ts` |
| Stacked review base | `stacked-review-base.test.ts` |

## Read-only shadow comparison

The 20 most recent merged UserTold PRs (#936–#955) were replayed from Git
commit parents, PR head SHAs, GitHub check runs, and the current required
`Tests` policy. The required check producer was GitHub App `15368`.

| PR | Candidate kind | Candidate SHA | Current required-check proof |
|-:|-|-|-|
| 955 | integration | `21a014d4a486bdd0f5b6c6fcec373f9e400cff86` | green |
| 954 | head | `96e891711b13f62196e8382fee6282c686eaf3f4` | green |
| 953 | integration | `dae15818ecb3300d29f88d1ec43afaae9bedae52` | green |
| 952 | head | `c1fb52e1124c775eecee9f089667e8d1676adfab` | green |
| 951 | head | `2968cdfc95fdcdc41010251cd80501acd9cc6656` | green |
| 950 | head | `ac1053850cdf431729a100ca427e08ab83ff02c3` | green |
| 949 | head | `f4aac58f90f3c35ea601bf6270e5cbadd61e62e3` | green |
| 948 | head | `f3fa66adfaf4e5bddead6149a634b8d943985b3a` | green |
| 947 | integration | `fc3ac447b88698e6c84e29cfc036cbca58a47056` | green |
| 946 | integration | `38bc471ce73a70a8e75c69d1d46b33920b9832c0` | green |
| 945 | head | `3d8e5fd3eb95b6c2eb1fd39783326cf9ec6d6a73` | green |
| 944 | head | `5fefe2ceda9dde06cd48cee4e54c4b214cff3bda` | green |
| 943 | integration | `04a95df0d6a2639dcbc901ea6df675c82980a0ef` | green |
| 942 | head | `8229d3f4fddec5cd3d58f7870126c6ec74a2a1c6` | green |
| 941 | head | `b76bd8e54a0fef31d98e412c24fb8a3d360b3768` | green |
| 940 | integration | `c7c347ad7895627c410e660b5e4d5132eda010ab` | green |
| 939 | integration | `d7620aac58a067bae8fab6a5b679de2701288522` | green |
| 938 | head | `5ebd5e86104cb42796f7c2413a29fad09ddd4dd8` | green |
| 937 | integration | `23f57db294b82fd4e5387b4d9f55449f8beac58d` | green |
| 936 | head | `c46b8edc2f314771f3a98e57119803bd46c98bb8` | blocked: failed |

Every candidate that the new policy would propose for landing is both green and
a descendant of its then-current base. PR #936 is the useful disagreement: its
head check failed while the old synthetic run later passed. The new behavior
does not land it and does not manufacture an identical-tree commit. It requests
a real failed-job rerun on the same head SHA within the configured flaky budget;
only a green rerun can make the candidate eligible.

The sample selects 12 exact heads and eight integration commits structurally.
Issue #630's earlier measurement of the same optimization class found 12/20
duplicate synthetic runs, about 64 runner-job-minutes, and median critical-path
latency of about 2.2 minutes. Exact heads now save that synthetic run; a flaky
head may consume a same-SHA rerun instead.

## Migration and legacy removal

On first open, Merge Steward copies active `spec_*` state into explicit
`candidate_*` columns, infers candidate kind, and physically drops the legacy
columns plus patch/tree shortcut fields. Review Quill physically drops its old
integration-tree surface columns and index. Existing rows with incomplete
carry-forward identity remain cache misses.

The production-shaped migration tests verify active candidate preservation and
the absence of retired columns. Source and documentation searches permit old
names only inside these one-way migrations and their fixtures.

## Rollout

1. Merge with a regular merge commit; do not squash.
2. Publish the release-bearing conventional commits for PatchRelay,
   Merge Steward, and Review Quill.
3. Upgrade all three production services and restart them.
4. Run each service's `doctor`, verify health/build versions, and inspect
   migrated schemas.
5. Observe at least one exact-head candidate and one integration candidate.
   For each landing, record current main, candidate SHA, policy fingerprint,
   check App, check result, and pushed SHA.
6. Confirm no synthetic CI was triggered for the exact head, integration CI
   ran for the divergent candidate, no stale queue labels remain, and Review
   Quill's stacked diff uses the captured GitHub base.

## Rollback

Stop admission before changing binaries. Keep the database and remote candidate
refs intact. Roll back all three packages to the previous release together,
then restart and run `doctor`. The schema migration is intentionally one-way:
the previous Merge Steward release cannot read candidate-only columns, so
binary rollback requires restoring the pre-upgrade database backup. Never
rewrite `main`; already-landed exact candidates are ordinary valid commits.
