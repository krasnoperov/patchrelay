# makefx-29-supported-failure-envelope

Repository: krasnoperov/makefx
Pull request: 29
Base SHA: 8cb74d4af87d68b98920f67194f2b9916ad2d755
Head SHA: 332760e9571f11da9c371008c6a02b25596fdfa6
Base branch: main
Head branch: krasnoperov-makefx/FX-26-image-generation-end-to-end-over-http-and-mcp
Title: feat(generation): add image generation over HTTP and MCP
Body file: makefx-pr-29-body.md
Expected verdict: request_changes
Maximum concerns: 8
Nits: allow

## Review docs

- AGENTS.md

## Must report

- none

## Must not report

- hold; durable; cleanup
- recovery; queue
- prolonged; outage

## Prior review claims

- Rejected or interrupted creates can strand a credit hold unless the PR adds durable server-side cleanup for pre-commit failures.

## Notes

Regression for a repository-defined failure envelope. The frozen head contains independently verified bugs inside documented normal or transient behavior, so the reviewer must still request changes. It must not require application machinery solely for the explicitly excluded prolonged infrastructure outage. Exact findings are intentionally unconstrained here; the complete-first-pass case owns recall coverage.
