import {
  checkExecutable,
  checkPath,
  fetchServiceAuthStatus,
  fetchServiceHealth,
  getHomeEnv,
  loadRepoConfigById,
  type CommandRunner,
} from "../cli-system.ts";
import { loadConfig } from "../config.ts";
import { getDefaultConfigPath, getReviewQuillPathLayout } from "../runtime-paths.ts";
import type { Output } from "./shared.ts";
import { formatJson, writeOutput } from "./shared.ts";
import { discoverRepoSettingsViaGhCli, queryReviewGateState } from "./gh.ts";
import type { ParsedArgs } from "./args.ts";

interface DoctorCheck {
  status: "pass" | "warn" | "fail";
  scope: string;
  message: string;
}

function buildReviewGateChecks(repoId: string, repoFullName: string, appSlug: string | undefined): DoctorCheck[] {
  if (!appSlug) {
    return [{
      status: "warn",
      scope: `repo:${repoId}:github-review-gate`,
      message: "Could not determine the running review-quill app slug, so live GitHub review-gate validation was skipped.",
    }];
  }

  const payload = queryReviewGateState(repoFullName);
  const prs = payload.data?.repository?.pullRequests?.nodes ?? [];
  const reviewed = prs.flatMap((pr) => {
    const review = pr.latestReviews?.nodes?.find((entry) => entry.author?.login === appSlug);
    return review ? [{
      prNumber: pr.number ?? 0,
      reviewDecision: pr.reviewDecision ?? "unknown",
      state: review.state ?? "unknown",
      authorCanPushToRepository: review.authorCanPushToRepository ?? false,
    }] : [];
  });

  if (reviewed.length === 0) {
    return [{
      status: "warn",
      scope: `repo:${repoId}:github-review-gate`,
      message: `No open PR currently has a latest ${appSlug} review, so GitHub gate counting could not be verified live.`,
    }];
  }

  const nonCounted = reviewed.filter((entry) => !entry.authorCanPushToRepository);
  if (nonCounted.length > 0) {
    return [{
      status: "warn",
      scope: `repo:${repoId}:github-review-gate`,
      message: `GitHub is not counting ${appSlug} on PR ${nonCounted.map((entry) => `#${entry.prNumber}`).join(", ")} because authorCanPushToRepository is false.`,
    }];
  }

  const mismatchedApprovals = reviewed.filter((entry) => entry.state === "APPROVED" && entry.reviewDecision !== "APPROVED");
  if (mismatchedApprovals.length > 0) {
    return [{
      status: "warn",
      scope: `repo:${repoId}:github-review-gate`,
      message: `GitHub still shows reviewDecision != APPROVED for ${appSlug} on PR ${mismatchedApprovals.map((entry) => `#${entry.prNumber}`).join(", ")}.`,
    }];
  }

  return [{
    status: "pass",
    scope: `repo:${repoId}:github-review-gate`,
    message: `GitHub is counting the latest ${appSlug} reviews on ${reviewed.map((entry) => `#${entry.prNumber}`).join(", ")}.`,
  }];
}

async function checkSecretReady(
  runCommand: CommandRunner,
  credentialName: string,
  envKeys: string[],
): Promise<boolean> {
  const env = getHomeEnv();
  if (envKeys.some((key) => {
    const value = env[key];
    return typeof value === "string" && value.trim().length > 0;
  })) {
    return true;
  }

  const result = await runCommand("sudo", ["test", "-e", `/etc/credstore.encrypted/${credentialName}.cred`]);
  return result.exitCode === 0;
}

export async function handleDoctor(parsed: ParsedArgs, stdout: Output, runCommand: CommandRunner): Promise<number> {
  const repoId = typeof parsed.flags.get("repo") === "string" ? String(parsed.flags.get("repo")) : undefined;
  const checks: DoctorCheck[] = [];
  const layout = getReviewQuillPathLayout();
  const env = getHomeEnv();
  let serviceAppSlug: string | undefined;

  const pathChecks = [
    ["home-config", layout.configPath, false],
    ["runtime-env", layout.runtimeEnvPath, false],
    ["service-env", layout.serviceEnvPath, false],
    ["state-dir", layout.stateDir, true],
    ["data-dir", layout.dataDir, true],
    ["systemd-unit", layout.systemdUnitPath, false],
  ] as const;
  for (const [scope, targetPath, writable] of pathChecks) {
    const result = checkPath(targetPath, writable);
    checks.push({ status: result.ok ? "pass" : "fail", scope, message: result.message });
  }

  for (const command of ["git", "gh", "codex"]) {
    const result = checkExecutable(command);
    checks.push({ status: result.ok ? "pass" : "fail", scope: command, message: result.message });
  }

  const appId = env.REVIEW_QUILL_GITHUB_APP_ID?.trim();
  checks.push({
    status: appId ? "pass" : "fail",
    scope: "github-app-id",
    message: appId ? `GitHub App id configured: ${appId}` : "GitHub App id is missing; set REVIEW_QUILL_GITHUB_APP_ID in service.env",
  });
  const githubAppKeyReady = await checkSecretReady(runCommand, "review-quill-github-app-pem", [
    "REVIEW_QUILL_GITHUB_APP_PRIVATE_KEY",
    "REVIEW_QUILL_GITHUB_APP_PRIVATE_KEY_FILE",
  ]);
  checks.push({
    status: githubAppKeyReady ? "pass" : "warn",
    scope: "github-app-key",
    message: githubAppKeyReady
      ? "GitHub App private key is configured"
      : "GitHub App private key is not configured via env/file or /etc/credstore.encrypted/review-quill-github-app-pem.cred",
  });
  const webhookSecretReady = await checkSecretReady(runCommand, "review-quill-webhook-secret", [
    "REVIEW_QUILL_WEBHOOK_SECRET",
    "REVIEW_QUILL_WEBHOOK_SECRET_FILE",
  ]);
  checks.push({
    status: webhookSecretReady ? "pass" : "warn",
    scope: "webhook-secret",
    message: webhookSecretReady
      ? "Webhook secret is configured"
      : "Webhook secret is not configured via env/file or /etc/credstore.encrypted/review-quill-webhook-secret.cred",
  });

  try {
    const config = loadConfig(layout.configPath);
    checks.push({
      status: "pass",
      scope: "config",
      message: `Config is valid with ${config.repositories.length} watched repos`,
    });
  } catch (error) {
    checks.push({
      status: "fail",
      scope: "config",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const health = await fetchServiceHealth();
    checks.push({
      status: "pass",
      scope: "service-health",
      message: `Local service is reachable with ${health.repos.length} repos`,
    });
  } catch (error) {
    checks.push({
      status: "warn",
      scope: "service-health",
      message: `Local service is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  try {
    const auth = await fetchServiceAuthStatus();
    serviceAppSlug = auth.appSlug;
    checks.push({
      status: auth.ready ? "pass" : "fail",
      scope: "service-auth",
      message: auth.ready
        ? auth.mode === "app" && auth.appId
          ? `Service GitHub auth is ready from App ${auth.appId}`
          : "Service GitHub auth is ready"
        : "Service GitHub auth is not ready",
    });
  } catch (error) {
    checks.push({
      status: "warn",
      scope: "service-auth",
      message: `Could not query running service auth: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  if (repoId) {
    try {
      const { repo } = loadRepoConfigById(repoId);
      checks.push({ status: "pass", scope: `repo:${repo.repoId}`, message: `Repo config is valid for ${repo.repoFullName}` });
      try {
        const discovered = discoverRepoSettingsViaGhCli(repo.repoFullName, repo.baseBranch);
        checks.push({
          status: discovered.defaultBranch === repo.baseBranch ? "pass" : "warn",
          scope: `repo:${repo.repoId}:github-default-branch`,
          message: discovered.defaultBranch === repo.baseBranch
            ? `Local base branch matches GitHub default branch (${discovered.defaultBranch})`
            : `Local base branch is ${repo.baseBranch}, but GitHub default branch is ${discovered.defaultBranch}`,
        });
        const localChecks = [...repo.requiredChecks].sort();
        const remoteChecks = [...discovered.requiredChecks].sort();
        const checksMatch = localChecks.length === remoteChecks.length && localChecks.every((value, index) => value === remoteChecks[index]);
        checks.push({
          status: !repo.waitForGreenChecks || checksMatch ? "pass" : "warn",
          scope: `repo:${repo.repoId}:github-required-checks`,
          message: !repo.waitForGreenChecks
            ? "Review starts immediately after branch updates; required-check alignment is informational only."
            : checksMatch
              ? (localChecks.length > 0
                  ? `Local required checks match GitHub for ${repo.baseBranch}`
                  : `No required checks configured locally and GitHub does not require status checks for ${repo.baseBranch}`)
              : `Local required checks [${localChecks.join(", ") || "(none)"}] differ from GitHub [${remoteChecks.join(", ") || "(none)"}] for ${repo.baseBranch}`,
        });
        checks.push({
          status: "pass",
          scope: `repo:${repo.repoId}:review-protocol`,
          message: "review-quill uses its GitHub App identity for normal PR approvals or change requests.",
        });
        for (const check of buildReviewGateChecks(repo.repoId, repo.repoFullName, serviceAppSlug)) {
          checks.push(check);
        }
      } catch (error) {
        checks.push({
          status: "warn",
          scope: `repo:${repo.repoId}:github-discovery`,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } catch (error) {
      checks.push({
        status: "fail",
        scope: `repo:${repoId}`,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const ok = checks.every((check) => check.status !== "fail");
  if (parsed.flags.get("json") === true) {
    writeOutput(stdout, formatJson({ ok, checks }));
    return ok ? 0 : 1;
  }

  const lines = ["review-quill doctor", ""];
  for (const check of checks) {
    const marker = check.status === "pass" ? "PASS" : check.status === "warn" ? "WARN" : "FAIL";
    lines.push(`${marker} [${check.scope}] ${check.message}`);
  }
  lines.push("");
  lines.push(ok ? "Doctor result: ready" : "Doctor result: not ready");
  writeOutput(stdout, `${lines.join("\n")}\n`);
  return ok ? 0 : 1;
}
