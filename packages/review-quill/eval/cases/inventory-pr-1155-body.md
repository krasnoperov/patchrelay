Project every persisted MCP Variant recipe through one recursive public serializer before returning it.

Preserve user-facing reproducibility settings while removing lineage duplication, storage routing, internal identities, workflow and provider diagnostics, credentials, tokens, and binary or base64 fields. Invalid or non-object legacy recipe data should return null.

The change is limited to MCP Variant output projection and its schema and tests. The same projection seam is used by both asset reads and variant updates.
