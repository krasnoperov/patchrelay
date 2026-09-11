Adds a new experimental Talk transport and prepares the widget for the intended replacement architecture.

Product and failure contract:

- The existing transport is transitional and is not a durable fallback target.
- A Study that selects the new model must remain on it. The runtime must not retry, substitute, or silently fall back to another model.
- If the new transport cannot start or fails, the application records the failure, completes the current Study step, and advances to the next step.
- The widget gzip budget increase is explicitly approved for this implementation.
