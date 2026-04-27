# Codex Session Source Forensics

PatchRelay and review-quill use Codex's own persisted session JSONL files as the raw forensic transcript source.

They should not mirror full transcripts into their SQLite databases.

## Contract

Store workflow truth locally:

- issue/run state
- review attempt state
- thread id
- turn id
- summaries and failure context

Resolve raw Codex transcript files on demand from:

- `CODEX_HOME/sessions`
- `~/.codex/sessions`

Resolver input:

- `threadId`

Resolver output:

- whether a matching session file exists
- file path
- start time when available
- working directory when available
- originator when available
- concrete error when missing or unreadable

## Resolution Rules

1. Search recursively for `.jsonl` files whose filename includes the `threadId`.
2. Read only the first line for metadata.
3. Treat a file as a match only when the first line is `session_meta` and `payload.id === threadId`.
4. Return lightweight metadata. Do not parse or cache the full transcript as part of normal issue or review reads.

## Operator Surfaces

Use the same labels in both tools:

- `Thread`
- `Session source`
- `Started`
- `Originator`
- `Working directory`

If the raw session file is missing, keep showing the thread id and render `Session source: not found` or the concrete error.

Commands that intentionally inspect transcripts may fail when a specifically requested run or attempt cannot be found. Normal status and list commands should not fail only because the raw Codex session file is unavailable.

## Non-Goals

- transcript mirroring into SQLite
- transcript search indexing
- GitHub or Linear publication of raw transcript content
- deep parsing of tool calls or hidden reasoning blobs
