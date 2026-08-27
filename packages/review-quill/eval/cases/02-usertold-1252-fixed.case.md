# usertold-1252-fixed-head

Repository: krasnoperov/usertold
Pull request: 1252
Base SHA: e72225c94d484b9aad8ba2ec7c51521b771be676
Head SHA: 7efc5965ed7cd0643b96880531b2de327af66468
Base branch: main
Head branch: claude/landing-timeline-polish
Title: feat(landing): make the session record inspectable instead of animated
Body file: usertold-pr-1252-body.md
Expected verdict: approve
Maximum concerns: 0
Nits: forbid

## Review docs

- REVIEW_WORKFLOW.md

## Must not report

- screen reader; focusable; mark; note
- persistent card; hover
- touch device; focus-visible

## Notes

This head is the direct repair. It adds accessible names and hides duplicate bubble content from assistive technology, so the previous blocker must close without a replacement nit. A hypothetical touch/`:focus-visible` fallback gap is not strong enough to replace it as a blocker.
