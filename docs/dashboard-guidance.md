# Dashboard Guidance

Dashboard views should show what the operator needs to do next without exposing internal attempt plumbing.

This applies to:

- PatchRelay issue dashboard and detail views
- review-quill watch/dashboard views
- merge-steward queue dashboard and detail views

## Core Rules

- Keep the primary row subject stable: issues for PatchRelay, PRs for review-quill and merge-steward.
- Prefer glyphs and short phrases over prose.
- Keep internal ids, check-run ids, thread ids, turn ids, and raw timestamps out of list views.
- Put forensic detail in logs, transcript commands, or explicit detail views.
- Separate native state from external observation. Do not invent cross-service states such as `queued_in_steward`.

## Tokens

Use one colored token per issue or PR:

| Meaning | Glyph | Color |
|-|-|-|
| running | `●` | yellow |
| queued or waiting | `○` | gray |
| completed or approved | `✓` | green |
| declined, blocked, or failed | `✗` | red |
| needs attention | `⚠` | red |
| cancelled or superseded | `─` / `↻` | gray |

The id and glyph share the same color.

Examples:

```text
owner/repo-a  #213 ●  #211 ✓  #205 ✗
USE-42        ● implementing  #101 ○ awaiting queue
```

## Progressive Disclosure

List views should answer:

- what is active
- what is waiting
- what recently completed or failed

Detail views can add:

- native state graph
- latest observation
- current plan or queue position
- one concise failure reason
- links or commands for deeper inspection

Avoid empty-state prose in dense lists. An empty token strip is enough.

## PatchRelay Details

PatchRelay issue views should distinguish:

- native issue/session state
- whether automation is paused because the issue is undelegated
- external queue observations from GitHub or merge-steward
- no-PR completion-check status

Paused issues should keep their real PR-backed state visible. Do not rewrite undelegated work into `awaiting_input` unless a human answer is actually required.

## Queue Details

merge-steward views should keep the queue order central:

- head-of-line entry
- entries behind the head
- native entry status
- latest incident for evicted entries
- whether external repair appears to have happened through a new head SHA

Failure text should say what happened and who owns the next move: steward retry, PatchRelay repair, PR owner, or operator.

## Forbidden Noise

Do not render these in dashboard list rows:

- cluster summary banners
- raw SHAs
- thread or turn ids
- webhook delivery ids
- created/updated/completed timestamps
- long review histories
- repeated "no activity" prose
- duplicated labels where the glyph already carries the state
