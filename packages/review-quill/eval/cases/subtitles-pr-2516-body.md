Add an idempotent seven-step first-week welcome series for new explicit marketing opt-ins.

The implementation records locale, signup interest, and a consent-time schedule; claims due deliveries with bounded retries and stale-claim recovery; rechecks consent immediately before sending; and removes campaign state during explicit user deletion.

Production and stage remain disabled until a valid launch cutoff and the feature flag are configured. Existing opt-ins are not backfilled.
