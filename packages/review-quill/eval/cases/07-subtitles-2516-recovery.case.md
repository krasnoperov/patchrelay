# subtitles-2516-recovery-head

Repository: krasnoperov/subtitles
Pull request: 2516
Base SHA: 0da48f8da943f935af47dc8e4f231184df160934
Head SHA: 6278e6719423972bf1c5eb0e1c4596b8c9c89ec4
Base branch: main
Head branch: historical-review-head
Title: Add idempotent first-week welcome series
Body file: subtitles-pr-2516-body.md
Expected verdict: request_changes
Maximum concerns: 2
Nits: forbid

## Must report

- claimed; interruption; permanently
- deletion; unsubscribe; token

## Must not report

- sqlite; iso; comparison
- disabled; backlog

## Notes

This late review head has two independent integration blockers: an interrupted claimed delivery can remain stranded permanently, and explicit user deletion leaves issued campaign unsubscribe tokens behind. Earlier timestamp-comparison and disabled-rollout backlog findings were repaired.
