# Dashboard Styleguide

This guide defines how the review-quill and merge-steward watch TUIs render a
developer-facing dashboard. The audience is a developer glancing at what is
happening to their PRs across projects — not an operator inspecting internal
attempt plumbing.

Follow this styleguide for any row-oriented watch view that shows PRs grouped
by repository. Details that do not fit inside these rules (diagnostics, forensic
fields, internal ids) belong in logs or dedicated debug surfaces, not the
dashboard.

## Subject And Scope

- The subject is always the pull request, not the attempt, thread, or turn.
- Every row represents one repository with a strip of PR tokens.
- The dashboard answers three questions and nothing else:
  1. What PRs are coming up for review or merge?
  2. What PRs are being worked on right now?
  3. What PRs have just been decided, and how?

## Color And Glyph Convention

Each PR token is `#<number><glyph>`. The PR number and the glyph share the same
color — they are one visual unit.

| State | Glyph | Color |
|-|-|-|
| running | `●` | yellow |
| queued / waiting-on-checks | `○` | gray |
| approved / merged | `✓` | green |
| changes requested / declined / merge-blocked | `✗` | red |
| errored / stuck / failed | `⚠` | red |
| cancelled | `─` | gray |
| superseded | `↻` | gray |

The PR number is never rendered in a different color from its glyph. Never mix
a green number with a red glyph, or vice versa. If a PR is approved, both `#42`
and `✓` are green.

## Ordering

- The selected repo is always the top row.
- Inside a repo's PR strip, tokens appear in this order:
  1. running
  2. queued / waiting on checks
  3. recently decided (approved, changes requested, error) — newest first
- Cancelled and superseded PRs do not appear unless they are the only signal.

## Time Window For Decided PRs

- Default window: last **24h** for decided PRs on every row, list or detail.
- Running and queued PRs ignore the window — they are always shown.
- Optional keybinding may widen the window (`h` = 24h default, `d` = 7d, `a` =
  all). The default stays tight.
- Never fill a row with prose when the window is empty. A shorter glyph strip
  (or no strip) is the correct signal.

## Progressive Disclosure By Height

The dashboard has two states that differ only by whether the selection cursor
`>` is drawn:

- **list state** — cursor visible; up/down cycles through repos; enter opens
  detail.
- **detail state** — cursor hidden; up/down still cycles through repos (so the
  reader can glide between projects); esc returns to list.

The first line of both states is identical: the repo slug followed by its PR
token strip. What grows below the first line differs:

- **list grows sideways to neighbors** — more repos.
- **detail grows downward into the selected repo** — more PRs.

Grades, by lines available:

### 1 line

List and detail render the same content; only the cursor changes.

```
> owner/repo-a  #213 ●  #211 ✓  #209 ✓  #208 ✓
```

### 2 lines

List adds one neighbor. Detail adds the selected repo's most-active PR.

List:
```
> owner/repo-a  #213 ●  #211 ✓  #209 ✓  #208 ✓
  owner/repo-b  #482 ●  #480 ○  #479 ✓  #476 ✗
```

Detail:
```
  owner/repo-a  #213 ●  #211 ✓  #209 ✓  #208 ✓
  #213  ●  reviewing
```

### 3 lines

List shows three repos. Detail shows two PRs under the selected repo.

### ~6 lines

List fits most repos. Detail shows the repo's active and recent PRs.

### ~10 lines

List shows all active repos; quiet repos collapse to a trailing `+N quiet`
line. Detail begins rendering short verdict summaries for decided PRs.

```
  owner/repo-a  #213 ●  #211 ✓  #209 ✓  #208 ✓

  #213  ●  reviewing
  #211  ✓  approved
  #209  ✓  approved
  #208  ✓  approved
  #205  ✗  changes requested
           N+1 query in loadDashboardModel; unbounded cursor.
```

### roomy

Detail expands verdict summaries for decided PRs. Running and queued PRs stay
with a single phrase — there is no content worth rendering yet.

## Row Content By Width

Within a row for one PR:

- **tight** — `#id glyph` (aligned columns so glyphs line up).
- **medium** — `#id glyph phrase`. The phrase is short and human (`reviewing`,
  `waiting for checks`, `approved`, `changes requested`, `merging`, `merged`,
  `head-of-line`, `behind head`, `evicted`, `review errored`). Approval and
  decline never need a phrase beyond the one verb — the glyph is the message.
- **full** — `#id glyph phrase` plus a short verdict summary wrapped below.
  Summaries are capped at ~2–3 wrapped lines and cut on a sentence boundary.
  Never end with `…`. If the summary would not fit cleanly, omit it entirely.

Running and queued PRs never get a verdict summary — there is nothing to
summarise yet.

## Forbidden Noise

Do not render any of the following on the dashboard:

- Cluster summary lines of the form `N repos | N online | N active | ...`.
- Per-repo health labels (`Reviewing`, `Idle`, `Needs attention`) — the glyphs
  already carry that meaning.
- Leading prose prefixes (`Reviews: ...`, `Queue: ...`).
- Empty-state prose (`no eligible review work`, `no review attempts yet`,
  `No recent activity yet`). An empty strip means nothing to show.
- Commit SHAs, attempt ids, thread ids, turn ids, check-run ids.
- Created / Updated / Completed timestamps or relative-time suffixes
  (`3m ago`, `2h ago`).
- "Reviewed head: ..." / "Current PR head: ..." lines.
- Review history sections or lists of prior attempts.
- Ellipsis-based truncation (`...`) on lists or summaries.

When a fact truly matters (for example, the PR head has moved past the
reviewed head), surface it inline on the active row, only when it changes what
the developer should do:

```
owner/repo-a #476  ✗  changes requested   (stale: head moved)
```

Otherwise omit it.

## Navigation Rules

- `up` / `down` (and `k` / `j`) cycle repos in both states.
- `enter` toggles from list to detail (cursor disappears).
- `esc` / `backspace` toggles from detail back to list (cursor reappears).
- `q` quits.
- `r` triggers a reconcile tick where available.
- Filters that materially change what is shown get a single letter binding;
  nothing else.

## Where This Applies

- `packages/review-quill/src/watch/*` — list and detail views.
- `packages/merge-steward/src/watch/*` — overview, queue list, and per-entry
  detail.
- `src/cli/watch/*` — patchrelay issue list, issue detail (event log), and
  issue app-server log views.

Other row-oriented dashboards added later should follow the same rules.

## Issue Token (patchrelay)

The patchrelay dashboard is issue-centric: each row is a Linear issue. The
issue token follows the same color convention as the PR token, mapped from
`FactoryState`:

| FactoryState | Glyph | Color | Phrase |
|-|-|-|-|
| `delegated` | `○` | gray | `delegated` |
| `implementing` | `●` | yellow | `implementing` |
| `pr_open` | `●` | yellow | `pr_open` |
| `changes_requested` | `●` | yellow | `changes requested` |
| `repairing_ci` | `●` | yellow | `repairing ci` |
| `awaiting_queue` | `●` | yellow | `awaiting queue` |
| `repairing_queue` | `●` | yellow | `repairing queue` |
| `awaiting_input` | `⚠` | red | `needs human` |
| `escalated` | `⚠` | red | `escalated` |
| `done` | `✓` | green | `done` |
| `failed` | `✗` | red | `failed` |

The issue key (e.g. `EQ-42`) and its glyph share a color. The related PR,
when one exists, is rendered as a separate PR token to the right using the
existing PR color convention — never double-labelled with the issue state.

## Event Log Rules

The patchrelay detail view is an event log. Rules:

- One line per event: `age  category  phrase`.
- Age is a single relative token (`2h`, `5m`, `now`), left-aligned in a
  fixed-width column.
- Category is one of: `stage`, `run`, `github`, `review`, `human`. No other
  categories appear — internal webhook deliveries, low-level item events,
  per-check status changes are dropped.
- Phrase is terse and severity-colored (red for failures, green for success,
  yellow for attention, gray for routine).
- A failure line may be followed by one indented continuation line with the
  concrete reason (exit code, check name, message). Never more than one.
- Side-trip repairs (CI fix, queue repair) fold inline with a leading `↳`.
  No separate history tab.

## App-Server Log Rules

The app-server log view is a Codex transcript for the active or latest run.
Rules:

- Header line reuses the issue-row format plus a dim thread-and-turn id
  suffix. Nothing else.
- Body is one entry per thread item, role-prefixed (`user`, `assistant`,
  `tool`), plain indentation. No box drawing.
- `tool` blocks render dim; `assistant` bright; `user` neutral.
- Stage labels, plan progress, blockers, retry controls do not appear here
  — those belong in the detail view.
