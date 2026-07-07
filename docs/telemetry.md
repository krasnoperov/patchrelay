# PatchRelay Telemetry

PatchRelay has two separate observability contracts:

- `PatchRelayTelemetryEvent` is the internal machine-facing event stream. It is full fidelity, stable enough for sinks, and not part of the dashboard or HTTP API contract.
- `OperatorFeedEvent` is the curated human-facing activity stream. The dashboard consumes operator feed events, not raw telemetry.

## Current fanout

Production wires telemetry in `PatchRelayService` with `FanoutPatchRelayTelemetry`:

```ts
const telemetry = new FanoutPatchRelayTelemetry([
  new LoggerTelemetrySink(logger),
  new OperatorFeedTelemetrySink(this.feed),
]);
```

The logger sink receives every telemetry event. The operator-feed sink translates only high-signal events into persisted human activity rows, such as dependency unblocks, actionable run skips, and health invariant warnings or repairs.

Telemetry sink failures must never affect workflow execution. New sinks should be called through `emitTelemetry`, either directly or by being added to `FanoutPatchRelayTelemetry`, so a broken sink cannot block a dispatch, run, lease, or webhook path.

## Adding an OpenTelemetry sink

Add OpenTelemetry as another `PatchRelayTelemetry` implementation rather than changing dashboard or operator-feed behavior:

```ts
export class OpenTelemetryTelemetrySink implements PatchRelayTelemetry {
  emit(event: PatchRelayTelemetryEvent): void {
    // Convert internal events to OpenTelemetry metrics, spans, or span events.
  }
}
```

Then append it to the production fanout:

```ts
const telemetry = new FanoutPatchRelayTelemetry([
  new LoggerTelemetrySink(logger),
  new OperatorFeedTelemetrySink(this.feed),
  new OpenTelemetryTelemetrySink(...),
]);
```

Keep these boundaries:

- Do not expose `PatchRelayTelemetryEvent` directly over HTTP.
- Do not make dashboard rendering depend on raw telemetry event names.
- Do not send every telemetry event to the operator feed. Add only events that answer an operator question like "why did this not run?" or "what just became unblocked?"
- Prefer low-cardinality OpenTelemetry metric labels. Use high-cardinality fields such as `issueKey`, `linearIssueId`, `runId`, `eventIds`, and `leaseId` as span attributes or log fields, not metric dimensions.

Useful initial OpenTelemetry mappings:

- `run.started`, `run.completed`, `run.failed` as run lifecycle span events and counters.
- `run.skipped` as a counter labeled by `reason` and `runType`.
- `dispatch.suppressed` as a counter labeled by `reason`.
- `health.invariant` as a counter labeled by `invariant` and `status`.
- `lease.acquire_failed` and `lease.expired` as lease-health counters.
