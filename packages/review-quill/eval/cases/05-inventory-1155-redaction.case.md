# inventory-1155-redaction-head

Repository: krasnoperov/inventory
Pull request: 1155
Base SHA: 6ce5a43c5b37ecb2813ee42b6de1d5efe697ccea
Head SHA: 4958c2f652b9dc08ae4136830d6e7bb178825949
Base branch: main
Head branch: historical-review-head
Title: fix(mcp): project stored recipes before returning them
Body file: inventory-pr-1155-body.md
Expected verdict: request_changes
Maximum concerns: 1
Nits: forbid

## Must report

- credential; expos

## Must not report

- requestHeaders; cookie
- password; clientSecret; accessKey
- generationDiagnostic; container

## Notes

The recursive serializer still exposes an independently supported sensitive or internal field family. Historical review identified scalar diagnostics; the baseline found concrete token and identity aliases accepted by the same arbitrary provenance input. Either root cause is useful, but the review should remain focused to one projection defect.
