# Review Quill evaluation

This is a local replay harness. It never starts the Review Quill service and never publishes a GitHub review.

Each `*.case.md` file freezes one PR base/head pair and describes the expected result in plain Markdown. Marker groups use semicolons: every phrase in a group must occur in one normalized concern. Keep markers short and semantic rather than copying a whole historical review.

Run the small suite once per case:

```bash
pnpm eval
```

The harness finds repositories under `~/projects` by default. For another layout:

```bash
pnpm eval --repos-dir /path/to/checkouts
```

It creates a detached temporary worktree, builds the real Review Quill prompt and diff inventory, runs native `review/start`, normalizes with the production schema, applies publication filtering, validates changed-line anchors, and writes a readable `eval/results/<timestamp>/report.md`.

## Adding a case

Copy an existing case and change the frozen SHAs and expectations. PR body text lives in a normal Markdown sidecar so it can contain headings without escaping.

The checks are intentionally simple:

- exact delivered verdict;
- maximum number of normalized concerns;
- no nits when forbidden;
- every line finding anchors to a changed new-version line;
- required marker groups appear;
- forbidden marker groups do not appear.

These are smoke checks, not a substitute for reading the raw native review included in the report. Add cases when a review exposes a new recurring failure mode; avoid adding prompt rules for one-off wording differences.
