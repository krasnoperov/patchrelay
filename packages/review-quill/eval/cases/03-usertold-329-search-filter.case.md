# usertold-329-search-filter-head

Repository: krasnoperov/usertold
Pull request: 329
Base SHA: 6e0c3dd8c07c5fdd6a9d5a653a2f09da90c57fb2
Head SHA: a18ae22545647b2fd9d7f7b70fd5756d0afaaf5a
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

- vector; surface; top

## Must not report

- existing; embedding; metadata
- evidence; removal
- fts; isolation

## Notes

This late review head filters semantic candidates only after Vectorize has applied its result limit. Non-product candidates can therefore crowd valid product results out of the requested top set. The baseline also found two concrete surface-default gaps that historical review missed; they remain acceptable when independently supported. Earlier evidence-removal, MCP, and full-text-search findings were repaired.
