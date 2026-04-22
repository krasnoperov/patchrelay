import type { PatchRelayDatabase } from "../db.ts";
import type { NormalizedEvent } from "../types.ts";

export function isInertPatchRelayComment(
  issue: NonNullable<ReturnType<PatchRelayDatabase["getIssue"]>>,
  commentId: string,
  body: string,
  actorType?: string,
): boolean {
  if (commentId === issue.statusCommentId) {
    return true;
  }
  if (body.startsWith("## PatchRelay status")) {
    return true;
  }
  const normalizedActorType = actorType?.trim().toLowerCase();
  if (normalizedActorType && normalizedActorType !== "user") {
    return isPatchRelayGeneratedActivityComment(body);
  }
  return false;
}

export function isPatchRelayManagedCommentAuthor(
  installation: ReturnType<PatchRelayDatabase["linearInstallations"]["getLinearInstallationForProject"]>,
  actor: NormalizedEvent["actor"],
  commentUserName?: string,
): boolean {
  const actorName = actor?.name?.trim().toLowerCase();
  const commentAuthor = commentUserName?.trim().toLowerCase();
  const installationName = installation?.actorName?.trim().toLowerCase();
  if (installation?.actorId && actor?.id === installation.actorId) {
    return true;
  }
  if (installationName && actorName === installationName) {
    return true;
  }
  if (actorName === "patchrelay" || commentAuthor === "patchrelay") {
    return true;
  }
  return false;
}

export function isPatchRelayGeneratedActivityComment(body: string): boolean {
  return body.startsWith("PatchRelay needs human help to continue.")
    || body.startsWith("PatchRelay is already working on ")
    || body.startsWith("PatchRelay received the ")
    || body.startsWith("PatchRelay routed your latest instructions into ")
    || body.startsWith("PatchRelay has stopped work as requested.")
    || body.startsWith("Merge preparation failed ")
    || body === "This thread is for an agent session with patchrelay.";
}

export function hasExplicitPatchRelayWakeIntent(body: string): boolean {
  return /\bpatchrelay\b/i.test(body);
}
