# Codex Session Source Forensics

## Goal

Use Codex's own persisted session JSONL files under `~/.codex/sessions` as the raw forensic source for both PatchRelay and review-quill.

Do not duplicate full transcripts into local SQLite databases.

## Decision

Both tools should:

- store and surface `threadId` as the stable link to Codex execution history
- resolve the corresponding session JSONL file on demand from the local filesystem
- expose the session file path and a small metadata preview in operator surfaces
- keep their own databases focused on workflow truth, not transcript mirroring

## Why This Shape

This is the right-sized solution because it gives operators a direct path from issue or review attempt to the raw source transcript without:

- building a second transcript store
- parsing or re-rendering all Codex events
- bloating local databases with large JSONL blobs

## Raw Source Contract

Resolver input:

- `threadId`

Resolver output:

- `exists`
- `path`
- `startedAt`
- `cwd`
- `originator`
- `error` when not found or unreadable

Resolution rules:

1. Search `CODEX_HOME/sessions` or `~/.codex/sessions` recursively for `.jsonl` files whose filename includes the `threadId`.
2. Read the first line only.
3. Treat the file as valid only when the first line is `session_meta` and `payload.id === threadId`.
4. Return a lightweight record; do not parse the full transcript.

## PatchRelay Checklist

Files to edit:

- `src/codex-session-source.ts`
  - add the filesystem resolver and metadata extraction
- `src/cli/data.ts`
  - enrich issue session history rows with `sessionSource`
  - add `transcriptSource(issueKey, runId?)`
- `src/cli/formatters/text.ts`
  - render `Session source`, `Started`, `Originator`, and `Working directory`
- `src/cli/commands/issues.ts`
  - add `issue transcript-source <issueKey> [--run <id>]`
- `src/cli/index.ts`
  - allow `--run` and `--json` for `issue transcript-source`
- `src/cli/help.ts`
  - document the new command and show session-source fields in the issue surface
- `test/cli.test.ts`
  - add temp `CODEX_HOME` fixtures
  - verify `issue sessions` shows the session source metadata
  - verify `issue transcript-source` resolves the exact JSONL file

## Review-Quill Checklist

Files to edit:

- `packages/review-quill/src/codex-session-source.ts`
  - add the same resolver contract used in PatchRelay
- `packages/review-quill/src/cli/attempts.ts`
  - enrich attempts with `sessionSource`
- `packages/review-quill/src/cli/transcript.ts`
  - show session-source metadata next to transcript output
- `packages/review-quill/src/cli/attempt-selection.ts`
  - keep attempt selection logic shared between transcript surfaces
- `packages/review-quill/src/cli/transcript-source.ts`
  - add `transcript-source <repo> <pr-number> [--attempt <id>]`
- `packages/review-quill/src/cli.ts`
  - route the new command
- `packages/review-quill/src/cli/args.ts`
  - allow `--attempt` and `--json` for `transcript-source`
- `packages/review-quill/src/cli/help.ts`
  - document the new command
- `packages/review-quill/test/cli.test.ts`
  - add temp `CODEX_HOME` fixtures
  - verify `attempts` shows the session source metadata
  - verify `transcript-source` resolves the exact JSONL file

## Operator Contract

Both tools should use the same labels where possible:

- `Thread`
- `Session source`
- `Started`
- `Originator`
- `Working directory`

If the raw session file is missing:

- keep showing `threadId`
- show `Session source: not found` or a concrete error
- do not fail the whole command unless the command explicitly requires a matching run/attempt

## Non-Goals

Do not implement any of the following in this change:

- transcript mirroring into SQLite
- transcript search indexing
- GitHub or Linear publication of raw transcript content
- deep parsing of tool calls or hidden reasoning blobs
