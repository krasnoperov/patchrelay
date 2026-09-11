Adds the first image generation path over HTTP and MCP with guarded credit holds, durable asset dispatch, bounded transient retries, and idempotent completion or failure.

Scope boundary: application-level recovery for a hypothetical prolonged managed-platform outage is intentionally out of scope. Repository guidance defines the supported failure envelope and rejects speculative recovery queues until a real observed failure or explicit requirement exists.
