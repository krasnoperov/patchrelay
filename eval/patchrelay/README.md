# PatchRelay prompt evaluation

Run `pnpm eval:patchrelay` to have `gpt-5.6-sol` evaluate the real PatchRelay developer instructions together with real prompts rendered for implementation, review-fix, and CI-repair cases.

The suite checks task preservation, harness/task boundaries, publication behavior, scope discipline, and harmful or contradictory instructions. It is intentionally separate from unit tests: unit tests protect deterministic composition, while this suite evaluates how the target model interprets the composed prompt.

The bundled cases include a distilled USE-983 / PR #1382 regression: after repeated review rounds, an explicitly excluded hypothetical reliability requirement must be refused for the active PR and created as a new undelegated related Linear follow-up instead of creating another implementation iteration. PatchRelay leaves search, deduplication, priority, and triage to another owner.

Use `--config <path>` to select a PatchRelay config instead of the installed default. The evaluator runs read-only and does not execute the quoted task prompts.
