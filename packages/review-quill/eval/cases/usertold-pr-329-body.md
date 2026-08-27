UserTold now keeps customer product findings separate from interview and widget findings so customer backlog exports default to product-under-test work.

What changed:

- Added a target surface for signals and tasks.
- Threaded the surface through extraction, task creation, storage, API, MCP, CLI filters, and response contracts.
- Defaulted task and signal lists and ready-task handoff to product-under-test while allowing explicit surface or all filters.
- Skipped automatic provider push for non-product tasks while leaving explicit push paths available.

Legacy or missing target surfaces should behave as product-under-test data. List and readiness paths should default to product-only while API, CLI, and MCP callers can explicitly request all or a specific surface.
