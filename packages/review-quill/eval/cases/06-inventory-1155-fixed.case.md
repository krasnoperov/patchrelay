# inventory-1155-fixed-head

Repository: krasnoperov/inventory
Pull request: 1155
Base SHA: 6ce5a43c5b37ecb2813ee42b6de1d5efe697ccea
Head SHA: b0edd6888c7ade65e7169533f32c7059f3538d70
Base branch: main
Head branch: historical-review-head
Title: fix(mcp): project stored recipes before returning them
Body file: inventory-pr-1155-body.md
Expected verdict: request_changes
Maximum concerns: 1
Nits: forbid

## Must report

- reference; reproduc

## Must not report

- diagnostic; scalar; survive
- requestHeaders; cookie
- password; clientSecret; accessKey
- generationDiagnostic; container

## Notes

This repair removes the historically reported scalar diagnostics, but repeated inspection found concrete remaining projection defects: scalar workflow metadata can bypass the filter, and the sanitizer drops public reference ordering and timing needed for reproducibility. The case records the strongest current-head concern rather than treating historical approval as ground truth.
