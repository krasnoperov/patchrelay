# usertold-329-legacy-vector-head

Repository: krasnoperov/usertold
Pull request: 329
Base SHA: 6e0c3dd8c07c5fdd6a9d5a653a2f09da90c57fb2
Head SHA: d8959b4f354942c60425f04260856aa271d9492a
Base branch: main
Head branch: historical-review-head
Title: feat: separate interview findings from product work
Body file: usertold-pr-329-body.md
Expected verdict: request_changes
Maximum concerns: 3
Nits: forbid

## Review docs

- REVIEW_WORKFLOW.md

## Must report

- vector; metadata; surface

## Must not report

- candidate; crowd; top
- evidence; removal
- fts; isolation

## Notes

The next repair moves filtering into Vectorize, but existing stored embeddings have no target-surface metadata. The new default product filter silently drops those legacy results. The earlier candidate-crowding problem is resolved; additional independently supported synchronization or internal-default defects are acceptable.
