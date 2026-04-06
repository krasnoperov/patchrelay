import { createHmac, timingSafeEqual } from "node:crypto";
import type { Logger } from "pino";
import type { MergeStewardService } from "./service.ts";
import type { GitHubPRApi } from "./interfaces.ts";

/**
 * Normalized webhook event — the subset the steward cares about.
 */
export type StewardWebhookEvent =
  | { type: "pr_labeled"; prNumber: number; branch: string; headSha: string; label: string }
  | { type: "pr_unlabeled"; prNumber: number; label: string }
  | { type: "pr_merged"; prNumber: number }
  | { type: "pr_closed"; prNumber: number }
  | { type: "pr_synchronize"; prNumber: number; branch: string; headSha: string }
  | { type: "review_approved"; prNumber: number; branch: string; headSha: string }
  | { type: "check_suite_completed"; prNumber: number | null; branch: string; headSha: string; conclusion: string }
  | { type: "push"; ref: string; headSha: string };

/**
 * Verify GitHub webhook signature (HMAC-SHA256).
 */
export function verifySignature(
  payload: string | Buffer,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature) return false;
  const expected = "sha256=" + createHmac("sha256", secret)
    .update(payload)
    .digest("hex");
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

/**
 * Normalize a GitHub webhook payload into a StewardWebhookEvent.
 * Returns undefined for events the steward doesn't care about.
 */
export function normalizeWebhook(
  eventType: string,
  payload: Record<string, unknown>,
): StewardWebhookEvent | undefined {
  switch (eventType) {
    case "pull_request": {
      const action = payload.action as string;
      const pr = payload.pull_request as Record<string, unknown>;
      const prNumber = Number(pr.number);
      const branch = String((pr.head as Record<string, unknown>).ref);
      const headSha = String((pr.head as Record<string, unknown>).sha);

      if (action === "labeled") {
        const label = (payload.label as Record<string, unknown>)?.name;
        return { type: "pr_labeled", prNumber, branch, headSha, label: String(label) };
      }
      if (action === "unlabeled") {
        const label = (payload.label as Record<string, unknown>)?.name;
        return { type: "pr_unlabeled", prNumber, label: String(label) };
      }
      if (action === "closed" && pr.merged === true) {
        return { type: "pr_merged", prNumber };
      }
      if (action === "closed") {
        return { type: "pr_closed", prNumber };
      }
      if (action === "synchronize") {
        return { type: "pr_synchronize", prNumber, branch, headSha };
      }
      return undefined;
    }

    case "pull_request_review": {
      const action = payload.action as string;
      if (action !== "submitted") return undefined;
      const review = payload.review as Record<string, unknown>;
      if (review.state !== "approved") return undefined;
      const pr = payload.pull_request as Record<string, unknown>;
      return {
        type: "review_approved",
        prNumber: Number(pr.number),
        branch: String((pr.head as Record<string, unknown>).ref),
        headSha: String((pr.head as Record<string, unknown>).sha),
      };
    }

    case "check_suite": {
      const action = payload.action as string;
      if (action !== "completed") return undefined;
      const suite = payload.check_suite as Record<string, unknown>;
      const pullRequests = suite.pull_requests as Array<Record<string, unknown>> | undefined;
      const firstPR = pullRequests?.[0];
      return {
        type: "check_suite_completed",
        prNumber: firstPR ? Number(firstPR.number) : null,
        branch: String(suite.head_branch),
        headSha: String(suite.head_sha),
        conclusion: String(suite.conclusion),
      };
    }

    case "push": {
      return {
        type: "push",
        ref: String(payload.ref),
        headSha: String(payload.after),
      };
    }

    default:
      return undefined;
  }
}

/**
 * Process a normalized webhook event against the steward service.
 */
export async function processWebhookEvent(
  event: StewardWebhookEvent,
  service: MergeStewardService,
  config: { admissionLabel: string; baseBranch: string; repoFullName: string; github?: GitHubPRApi },
  logger: Logger,
): Promise<void> {
  switch (event.type) {
    case "pr_labeled": {
      if (event.label !== config.admissionLabel) return;
      logger.info({ prNumber: event.prNumber }, "Admission label added, checking eligibility");
      await service.tryAdmit(event.prNumber, event.branch, event.headSha);
      break;
    }

    case "pr_unlabeled": {
      if (event.label !== config.admissionLabel) return;
      // Label removed — dequeue if active.
      service.dequeueByPR(event.prNumber);
      break;
    }

    case "pr_merged": {
      service.acknowledgeExternalMerge(event.prNumber);
      break;
    }

    case "pr_closed": {
      service.dequeueByPR(event.prNumber);
      break;
    }

    case "pr_synchronize": {
      // PR was force-pushed. Update head if queued.
      service.updateHeadByPR(event.prNumber, event.headSha);
      break;
    }

    case "review_approved": {
      // Review approved — check merge-gate eligibility and enqueue if ready.
      logger.info({ prNumber: event.prNumber }, "Review approved, checking eligibility");
      await service.tryAdmit(event.prNumber, event.branch, event.headSha);
      break;
    }

    case "check_suite_completed": {
      if (event.conclusion !== "success") break;
      let prNumber = event.prNumber;
      if (!prNumber && event.branch && config.github) {
        prNumber = await config.github.findPRByBranch(event.branch);
      }
      if (prNumber) {
        logger.info({ prNumber, branch: event.branch }, "Check suite passed, checking admission");
        await service.tryAdmit(prNumber, event.branch, event.headSha);
      }
      break;
    }

    case "push": {
      // Push to base branch — the reconciler will pick up the new base
      // on the next tick (non-spinning retry gate checks baseSha).
      if (event.ref === `refs/heads/${config.baseBranch}`) {
        logger.debug("Base branch pushed, reconciler will pick up new base");
      }
      break;
    }
  }
}
