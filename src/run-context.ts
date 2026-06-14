import { z } from "zod";

// Plan §D1: the one typed schema for the run context object — the bag that is
// (a) stored in `issues.pending_run_context_json` (legacy pending-wake path,
//     read back by RunWakePlanner.materializeLegacyPendingWake),
// (b) carried in session-event `event_json` payloads for wake events and
//     merged into the wake plan by deriveSessionWakePlan, and
// (c) passed around in memory as `context` / `effectiveContext` /
//     `pendingRunContext` until it reaches the prompt builder and launcher.
//
// Every known field is typed strictly so a mistyped field fails loudly at the
// parse boundary. Unknown keys are deliberately TOLERATED (loose object), not
// rejected, because:
// - existing DB rows contain contexts written by older PatchRelay versions
//   whose field sets we no longer produce (e.g. `mergeQueueContext`,
//   `userComment`, `operatorPrompt` below survive only as legacy reads), and
// - deriveSessionWakePlan merges whole event payloads into the context via
//   Object.assign, so producer-side extra keys flow through by design.
// The static `RunContext` type intentionally has NO index signature (it is
// inferred from a non-loose mirror of the same shape), so compile-time access
// to undeclared fields is an error even though runtime parsing passes unknown
// keys through. NESTED objects (ciSnapshot, incidentContext, reviewComments
// entries, ...) use plain z.object — unknown nested keys are stripped at the
// boundary instead of passed through: they are leaf display data, every field
// any consumer reads is declared here, and a single definition keeps the
// static type free of index signatures so producer-side `satisfies RunContext`
// checks stay sound.

/** Entry of `followUps`, assembled by deriveSessionWakePlan from
 * direct_reply / followup_prompt / followup_comment / operator_prompt event
 * payloads; consumed by prompting/patchrelay.ts buildFollowUpContextLines. */
const followUpEntryShape = {
  type: z.string().optional(),
  text: z.string().optional(),
  author: z.string().optional(),
};

/** Inline review comment captured from GitHub. Produced by
 * github-review-context.ts and reactive-run-policy.ts
 * hydrateRequestedChangesContext (remote-pr-review.ts);
 * consumed by prompting/patchrelay.ts readReviewFixComments and
 * run-orchestrator.ts (review round activity comment count). */
const reviewCommentShape = {
  id: z.number().optional(),
  body: z.string().optional(),
  path: z.string().optional(),
  line: z.number().optional(),
  side: z.string().optional(),
  startLine: z.number().optional(),
  startSide: z.string().optional(),
  commitId: z.string().optional(),
  url: z.string().optional(),
  diffHunk: z.string().optional(),
  authorLogin: z.string().optional(),
};

/** Related-issue summary used by the issue-topology prompt sections. Produced
 * by run-orchestrator.ts buildRelatedIssueContext; consumed by
 * prompting/patchrelay.ts summarizeRelationEntries. */
const relatedIssueShape = {
  linearIssueId: z.string().optional(),
  issueKey: z.string().optional(),
  title: z.string().optional(),
  stateName: z.string().optional(),
  stateType: z.string().optional(),
  factoryState: z.string().optional(),
  currentLinearState: z.string().optional(),
  delegatedToPatchRelay: z.boolean().optional(),
  hasOpenPr: z.boolean().optional(),
};

/** One check inside a CI snapshot (github-failure-context.ts
 * mapCiSnapshotCheck). */
const ciSnapshotCheckShape = {
  name: z.string().optional(),
  status: z.string().optional(),
  conclusion: z.string().optional(),
  detailsUrl: z.string().optional(),
  summary: z.string().optional(),
};

/** Settled CI snapshot. Produced by github-failure-context.ts
 * buildCiSnapshotFromChecks (attached to workflow task payloads by
 * workflow-runtime.ts and to implicit ci_repair wakes by
 * workflow-wake-resolver.ts); consumed by prompting/patchrelay.ts
 * buildCiRepairContext. */
const ciSnapshotShape = {
  headSha: z.string().optional(),
  gateCheckName: z.string().optional(),
  gateCheckStatus: z.string().optional(),
  settledAt: z.string().optional(),
  capturedAt: z.string().optional(),
  failedChecks: z.array(z.object(ciSnapshotCheckShape)).optional(),
  checks: z.array(z.object(ciSnapshotCheckShape)).optional(),
};

/** Queue-eviction incident detail (merge-queue-incident.ts
 * QueueEvictionIncidentContext), parsed from the steward's check-run output. */
const queueIncidentContextShape = {
  version: z.number().optional(),
  failureClass: z.string().optional(),
  baseSha: z.string().optional(),
  prHeadSha: z.string().optional(),
  queuePosition: z.number().optional(),
  baseBranch: z.string().optional(),
  branch: z.string().optional(),
  issueKey: z.string().nullable().optional(),
  conflictFiles: z.array(z.string()).optional(),
  failedChecks: z.array(z.object({
    name: z.string().optional(),
    conclusion: z.string().optional(),
    url: z.string().optional(),
  })).optional(),
  retryHistory: z.array(z.object({
    at: z.string().optional(),
    baseSha: z.string().optional(),
    outcome: z.string().optional(),
  })).optional(),
};

/** LEGACY: merge-queue context block read by prompting/patchrelay.ts
 * appendQueueRepairContext. No current producer writes this field — it only
 * appears in contexts persisted by older versions, so it stays in the schema
 * for legacy-row compatibility. */
const mergeQueueContextShape = {
  baseBranch: z.string().optional(),
  baseSha: z.string().optional(),
  mergeCommitSha: z.string().optional(),
  checkRunUrl: z.string().optional(),
  incidentSummary: z.string().optional(),
  conflictingFiles: z.array(z.string()).optional(),
  operatorHints: z.array(z.string()).optional(),
};

const runContextShape = {
  // ── Wake framing ──────────────────────────────────────────────────
  /** Why this wake exists. Produced by deriveSessionWakePlan (and by
   * branch-upkeep context builders, operator-retry-event); consumed by
   * prompting/patchrelay.ts (turn reason, follow-up prompt selection). Kept a
   * free string: the value set spans wake reasons and event types and legacy
   * rows carry values we no longer emit. */
  wakeReason: z.string().optional(),
  /** Requested run type inside a `delegated` / `completion_check_continue`
   * payload. Free string because legacy payloads carry removed run types
   * (e.g. "main_repair"); consumers narrow via parseRunType and fall back to
   * "implementation". */
  runType: z.string().optional(),
  /** Producer tag ("operator_retry", "queue_health_monitor",
   * "idle_reconciliation", ...). Produced by operator-retry-event.ts,
   * queue-health-monitor.ts, idle-reconciliation.ts; diagnostic only. */
  source: z.string().optional(),

  // ── Human / orchestration context ─────────────────────────────────
  /** Prompt guidance. Produced by buildBranchUpkeepContext /
   * buildReviewFixBranchUpkeepContext, operator-retry-event.ts,
   * queue-health-monitor.ts, webhooks/desired-stage-recorder.ts; consumed by
   * prompting/patchrelay.ts buildHumanContextLines. */
  promptContext: z.string().optional(),
  /** Latest human instruction body, from `delegated` payloads
   * (webhooks/desired-stage-recorder.ts); consumed by buildHumanContextLines. */
  promptBody: z.string().optional(),
  /** LEGACY: read by prompting/patchrelay.ts and
   * linear-agent-activity-recovery.ts; no current producer. */
  operatorPrompt: z.string().optional(),
  /** LEGACY: read by prompting/patchrelay.ts and
   * linear-agent-activity-recovery.ts; no current producer. */
  userComment: z.string().optional(),
  /** Recovered Linear agent-activity transcript. Produced by
   * linear-agent-activity-recovery.ts summarizeLinearAgentActivities; consumed
   * by prompting/patchrelay.ts buildHumanContextLines. */
  linearAgentActivityContext: z.string().optional(),
  /** Companion count for linearAgentActivityContext (same producer). */
  linearAgentActivityCount: z.number().optional(),
  /** Follow-up messages collected by deriveSessionWakePlan; consumed by
   * prompting/patchrelay.ts and linear-agent-activity-recovery.ts. */
  followUps: z.array(z.object(followUpEntryShape)).optional(),
  /** Set by deriveSessionWakePlan when followUps is non-empty; consumed by
   * prompting/patchrelay.ts shouldBuildFollowUpPrompt. */
  followUpMode: z.boolean().optional(),
  /** Produced by deriveSessionWakePlan; consumed by run-launcher.ts
   * shouldCompactThread. */
  followUpCount: z.number().optional(),
  /** Produced by deriveSessionWakePlan for direct_reply events. */
  directReplyMode: z.boolean().optional(),

  // ── Completion-check continuation ─────────────────────────────────
  /** Produced by deriveSessionWakePlan for completion_check_continue events. */
  completionCheckMode: z.boolean().optional(),
  /** Produced by deriveSessionWakePlan (from the event payload `summary`);
   * consumed by prompting/patchrelay.ts buildFollowUpContextLines. */
  completionCheckSummary: z.string().optional(),

  // ── Dirty-worktree continuation (run-finalizer.ts
  //    continueDirtyRepairWorktree → completion_check_continue payload) ──
  /** Consumed by run-launcher.ts shouldPreserveDirtyWorktreeBeforeLaunch and
   * prompting/patchrelay.ts buildFollowUpContextLines. */
  preserveDirtyWorktree: z.boolean().optional(),
  dirtyWorktreeSummary: z.string().optional(),
  dirtyWorktreeChangedPaths: z.array(z.string()).optional(),
  dirtyWorktreeMergeInProgress: z.boolean().optional(),

  // ── Replacement-PR facts (agent-input-service payloads merged by
  //    deriveSessionWakePlan; consumed by prompting/patchrelay.ts) ──
  replacementPrRequired: z.boolean().optional(),
  previousPrNumber: z.number().optional(),
  previousPrUrl: z.string().optional(),
  previousPrState: z.string().optional(),
  previousPrHeadSha: z.string().optional(),

  // ── Requested-changes / review fix ────────────────────────────────
  /** Coalescing identity for review_changes_requested wakes. Produced by
   * buildRequestedChangesWakeIdentity callers (run-wake-planner.ts,
   * github-review-context.ts, operator-retry-event.ts,
   * idle-reconciliation.ts); consumed by reactive-wake-keys.ts
   * readRequestedChangesCoalesceKey for event coalescing. */
  requestedChangesCoalesceKey: z.string().optional(),
  requestedChangesHeadSha: z.string().optional(),
  /** "branch_upkeep" is the only value ever produced (idle-reconciliation-
   * helpers.ts buildBranchUpkeepContext, reactive-pr-state.ts
   * buildReviewFixBranchUpkeepContext, run-failure-policy.ts); consumed by
   * run-launcher.ts, run-failure-policy.ts resolveRetryRunType and
   * prompting/patchrelay.ts resolveRequestedChangesMode. */
  reviewFixMode: z.enum(["branch_upkeep"]).optional(),
  /** Same producers/consumers as reviewFixMode (plus
   * review_changes_requested payloads from operator-retry-event.ts and
   * deriveSessionWakePlan branch selection). */
  branchUpkeepRequired: z.boolean().optional(),
  /** GitHub review id. Produced by github-review-context.ts and
   * reactive-run-policy.ts hydrateRequestedChangesContext; consumed by
   * prompting/patchrelay.ts buildStructuredReviewContext. */
  reviewId: z.number().optional(),
  reviewCommitId: z.string().optional(),
  reviewUrl: z.string().optional(),
  reviewerName: z.string().optional(),
  reviewBody: z.string().optional(),
  reviewComments: z.array(z.object(reviewCommentShape)).optional(),
  /** Produced by reactive-run-policy.ts hydrateRequestedChangesContext. */
  reviewContextStatus: z.enum(["fresh", "degraded"]).optional(),
  reviewContextDegraded: z.boolean().optional(),
  reviewContextDegradedReason: z.string().optional(),
  /** Produced by reactive-run-policy.ts hydrateRequestedChangesContext. */
  currentPrHeadSha: z.string().optional(),

  // ── Failure provenance (CI / queue repair) ────────────────────────
  /** Free-form failure tag: "queue_eviction" (merge-queue-incident.ts),
   * GitHubFailureSource values (idle-reconciliation-helpers.ts
   * buildFailureContext), "queue_eviction_missed" / "preemptive_conflict"
   * (queue-health-monitor.ts), "merge_conflict_detected"
   * (idle-reconciliation.ts); consumed by prompting/patchrelay.ts. */
  failureReason: z.string().optional(),
  failureSignature: z.string().optional(),
  failureHeadSha: z.string().optional(),
  /** Legacy alias for failureHeadSha still consulted by run-launcher.ts,
   * run-orchestrator.ts and idle-reconciliation-helpers.ts
   * isDuplicateRepairAttempt; also set by reactive-run-policy.ts
   * hydrateRequestedChangesContext (current PR head). */
  headSha: z.string().optional(),
  /** Produced by buildBranchUpkeepContext / buildReviewFixBranchUpkeepContext
   * (head that was failing/dirty at wake time). */
  failingHeadSha: z.string().optional(),
  // GitHubFailureContext fields (github-failure-context.ts), spread into
  // contexts by buildFailureContext / workflow-wake-resolver.ts /
  // operator-retry-event.ts; consumed by prompting/patchrelay.ts.
  checkName: z.string().optional(),
  checkUrl: z.string().optional(),
  checkDetailsUrl: z.string().optional(),
  jobName: z.string().optional(),
  stepName: z.string().optional(),
  summary: z.string().optional(),
  annotations: z.array(z.string()).optional(),
  workflowRunId: z.number().optional(),
  workflowName: z.string().optional(),
  repoFullName: z.string().optional(),
  capturedAt: z.string().optional(),
  /** Check classification from github-webhook-failure-context.ts
   * resolveGitHubCheckClass, attached to settled_red_ci payloads. */
  checkClass: z.string().optional(),
  /** See ciSnapshotShape. */
  ciSnapshot: z.object(ciSnapshotShape).optional(),

  // ── Queue repair (merge-queue-incident.ts QueueRepairContext) ─────
  incidentId: z.string().optional(),
  incidentUrl: z.string().optional(),
  incidentTitle: z.string().optional(),
  incidentSummary: z.string().optional(),
  incidentContext: z.object(queueIncidentContextShape).optional(),
  /** LEGACY (see mergeQueueContextShape). */
  mergeQueueContext: z.object(mergeQueueContextShape).optional(),
  queuePosition: z.number().optional(),
  /** Force a fresh PR head SHA on queue repair. Produced by
   * queue-health-monitor.ts and operator-retry-event.ts; consumed by
   * prompting/patchrelay.ts buildPublicationContract and
   * queue-health-monitor.ts isDuplicateProbe. */
  requiresFreshHead: z.boolean().optional(),

  // ── Branch upkeep facts ───────────────────────────────────────────
  /** Produced by buildBranchUpkeepContext / buildReviewFixBranchUpkeepContext;
   * consumed by prompting/patchrelay.ts buildFollowUpContextLines. */
  mergeStateStatus: z.string().optional(),
  baseBranch: z.string().optional(),
  /** Set when GitHub facts were refreshed immediately before launch;
   * consumed by prompting/patchrelay.ts (fact-freshness line). */
  githubFactsFresh: z.boolean().optional(),

  // ── Issue topology (implementation coordination context) ──────────
  /** Produced by run-orchestrator.ts buildRelatedIssueContext; consumed by
   * prompting/patchrelay.ts buildIssueTopology / orchestration constraints. */
  unresolvedBlockers: z.array(z.object(relatedIssueShape)).optional(),
  childIssues: z.array(z.object(relatedIssueShape)).optional(),
  /** LEGACY alias of childIssues, still read by prompting/patchrelay.ts. */
  trackedDependents: z.array(z.object(relatedIssueShape)).optional(),

  // ── Child-event facts (orchestration-parent-wake.ts payloads merged by
  //    deriveSessionWakePlan for child_changed / child_delivered /
  //    child_regressed) ──
  childIssueId: z.string().optional(),
  childIssueKey: z.string().optional(),
  childTitle: z.string().optional(),
  factoryState: z.string().optional(),
  currentLinearState: z.string().optional(),
  prNumber: z.number().optional(),
  prState: z.string().optional(),
  changeKind: z.string().optional(),
};

// Type source: no index signature, so reading an undeclared field is a
// compile-time error at every consumer.
const runContextTypeSchema = z.object(runContextShape);
export type RunContext = z.infer<typeof runContextTypeSchema>;

// Parse source: tolerates unknown keys (legacy rows / merged event payloads —
// see module comment) while still failing loudly on mistyped known fields.
export const runContextSchema = z.looseObject(runContextShape);

export class RunContextParseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RunContextParseError";
  }
}

/**
 * Validate an already-parsed value as a run context. FAILS LOUDLY
 * (RunContextParseError) on non-object values or mistyped known fields —
 * that is the point of D1; callers at legacy-row boundaries may catch,
 * warn, and treat the context as absent.
 */
export function parseRunContextValue(value: unknown, where = "run context"): RunContext {
  const result = runContextSchema.safeParse(value);
  if (!result.success) {
    throw new RunContextParseError(
      `Invalid ${where}: ${result.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")}`,
      { cause: result.error },
    );
  }
  return result.data as RunContext;
}

/**
 * Parse a stored run-context JSON string. Returns undefined for
 * null/undefined/empty input. FAILS LOUDLY (RunContextParseError) on
 * malformed JSON or schema violations — no silent fallback.
 */
export function parseRunContext(json: string | null | undefined, where = "run context"): RunContext | undefined {
  if (json === null || json === undefined || json.trim() === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new RunContextParseError(
      `Malformed ${where} JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  return parseRunContextValue(parsed, where);
}

/**
 * Boundary helper for sites that ingest possibly-old DB rows: parse loudly,
 * but on failure report through `warn` and degrade to "no context" instead of
 * unwinding the caller. The parse itself never silently coerces.
 */
export function parseRunContextOrWarn(
  json: string | null | undefined,
  warn: (message: string) => void,
  where = "run context",
): RunContext | undefined {
  try {
    return parseRunContext(json, where);
  } catch (error) {
    warn(error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

/**
 * Non-throwing variant for boundaries inside the persistence layer where no
 * logger is plumbed (workflow-wake-resolver assembling implicit wake contexts
 * from reconciliation columns): a value the schema rejects degrades to
 * "no context", which was already the legacy behavior for malformed JSON in
 * those columns. Everywhere a logger exists, prefer parseRunContextOrWarn so
 * the failure is at least observable.
 */
export function tryParseRunContextValue(value: unknown): RunContext | undefined {
  const result = runContextSchema.safeParse(value);
  return result.success ? result.data as RunContext : undefined;
}

/**
 * Serialize a run context for storage. Round-trips through the schema so
 * writers cannot persist a shape the parser would reject.
 */
export function serializeRunContext(context: RunContext, where = "run context"): string {
  return JSON.stringify(parseRunContextValue(context, where));
}
