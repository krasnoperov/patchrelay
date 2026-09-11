# usertold-1503-author-scope

Repository: krasnoperov/usertold
Pull request: 1503
Base SHA: 172c383aa16f3f80cfcf0818191d60752745104a
Head SHA: 3c3e509e88fd54ac4002f75884bf62ba1ab4c9ca
Base branch: main
Head branch: feature/use-1103-gpt-live-main-widget
Title: feat: add experimental Talk delegation
Body file: usertold-pr-1503-body.md
Expected verdict: request_changes
Maximum concerns: 6
Nits: forbid

## Must report

- none

## Must not report

- failure; fallback
- size; budget
- skip; segment

## PR conversation claims

- Product decision: transport or delegated-response failure completes the current step and advances normally. It must not retry or substitute another model. The approved size increase is intentional.

## Prior review claims

- Failures must fall back instead of completing the step, and the size budget should remain tighter.

## Notes

Regression for reviewer scope ownership. The frozen head contains independently verified contract bugs, so the reviewer must still request changes. It must not replace explicit author-owned failure semantics, replacement boundaries, or an approved budget with its preferred design. Exact findings are intentionally unconstrained here; the complete-first-pass case owns recall coverage.
