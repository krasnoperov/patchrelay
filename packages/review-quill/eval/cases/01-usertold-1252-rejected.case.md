# usertold-1252-rejected-head

Repository: krasnoperov/usertold
Pull request: 1252
Base SHA: e72225c94d484b9aad8ba2ec7c51521b771be676
Head SHA: 9363291f82147360146ffe51eb0f8800381b3a58
Base branch: main
Head branch: claude/landing-timeline-polish
Title: feat(landing): make the session record inspectable instead of animated
Body file: usertold-pr-1252-body.md
Expected verdict: request_changes
Maximum concerns: 1
Nits: forbid

## Review docs

- REVIEW_WORKFLOW.md

## Must report

- screen reader; focusable

## Must not report

- persistent card; hover
- touch device; focus-visible

## Notes

The historical first review blocked because empty focusable marks did not expose their sibling notes to screen readers. A weaker replay also complained that one hover note was not repeated in persistent cards; that should not delay this merge.
