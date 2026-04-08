import { spawnSync } from "node:child_process";
import pino from "pino";
import { loadConfig } from "./config.ts";
import { decorateAttempt } from "./attempt-state.ts";
import { SqliteStore } from "./db/sqlite-store.ts";
import { CodexAppServerClient } from "./codex-app-server.ts";
import {
  checkExecutable,
  checkPath,
  defaultRunCommand,
  fetchServiceAuthStatus,
  fetchServiceHealth,
  fetchWatchSnapshot,
  formatCommandFailure,
  getHomeEnv,
  listRepoConfigs,
  loadRepoConfigById,
  parseSystemctlShowOutput,
  runSystemctl,
  type CommandRunner,
} from "./cli-system.ts";
import {
  buildLocalDiffContext,
  defaultDiffRepoConfig,
  detectDefaultBranch,
  detectRepoFullNameFromCwd,
  estimateTokens,
  renderDiffContextLines,
} from "./diff-context/index.ts";
import { installServiceUnit, initializeReviewQuillHome, upsertRepoConfig } from "./install.ts";
import { getDefaultConfigPath, getReviewQuillPathLayout } from "./runtime-paths.ts";
import type { CodexThreadSummary, ReviewAttemptRecord, ReviewQuillConfig, ReviewQuillRepositoryConfig } from "./types.ts";

type HelpTopic = "root" | "repo" | "service";
type Output = Pick<NodeJS.WriteStream, "write">;

interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string | boolean>;
}

interface RunCliOptions {
  stdout?: Output;
  stderr?: Output;
  runCommand?: CommandRunner;
  readCodexThread?: (threadId: string) => Promise<CodexThreadSummary>;
}

class UsageError extends Error {
  constructor(message: string, readonly helpTopic: HelpTopic = "root") {
    super(message);
    this.name = "UsageError";
  }
}

interface DoctorCheck {
  status: "pass" | "warn" | "fail";
  scope: string;
  message: string;
}

interface GhBranchProtectionResponse {
  required_status_checks?: {
    contexts?: string[];
    checks?: Array<{ context?: string }>;
  };
}

interface GhRepoResponse {
  default_branch?: string;
}

interface GhReviewGateResponse {
  data?: {
    repository?: {
      pullRequests?: {
        nodes?: Array<{
          number?: number;
          reviewDecision?: string;
          headRefOid?: string;
          latestReviews?: {
            nodes?: Array<{
              state?: string;
              author?: { login?: string };
              authorCanPushToRepository?: boolean;
              commit?: { oid?: string };
            }>;
          };
        }>;
      };
    };
  };
}

function rootHelpText(): string {
  return [
    "review-quill",
    "",
    "Mental model:",
    "  review-quill is the PR review complement to PatchRelay and merge-steward.",
    "  It watches configured repositories, reviews merge-ready PR heads, and",
    "  publishes a normal GitHub PR review.",
    "",
    "Usage:",
    "  review-quill <command> [args] [flags]",
    "",
    "Happy path:",
    "  1. review-quill init <public-base-url>",
    "  2. Fill in ~/.config/review-quill/service.env",
    "  3. review-quill repo attach <owner/repo>",
    "  4. review-quill doctor --repo <id>",
    "  5. review-quill service status",
    "  6. review-quill dashboard",
    "",
    "Everyday commands:",
    "  init <public-base-url> [--force] [--json]              Bootstrap the local review-quill home and systemd unit",
    "  repo attach <owner/repo> [--base-branch <branch>] [--required-check <checks>] [--review-doc <paths>] [--refresh] [--json]",
    "                                                          Create or update a watched repository and restart the service",
    "  repo list [--json]                                     List watched repositories",
    "  repo show <id> [--json]                                Show one repo config",
    "  attempts <repo> <pr-number> [--json]                   Show recorded review attempts for one pull request",
    "  transcript <repo> <pr-number> [--attempt <id>] [--json]  Show the full visible Codex thread for one recorded review attempt",
    "  doctor [--repo <id>] [--json]                          Validate config, secrets, binaries, and service reachability",
    "  service status [--json]                                Show systemd state and local health",
    "  service logs [--lines <count>] [--json]                Show recent journal logs",
    "  dashboard [--config <path>]                            Open the review dashboard",
    "",
    "Service management:",
    "  service install [--force] [--json]                     Reinstall the systemd unit",
    "  service restart [--json]                               Reload-or-restart the service",
    "",
    "Advanced commands:",
    "  serve [--config <path>]                                Run the review-quill service",
    "  watch [--config <path>]                                Alias for `dashboard`",
    "  diff [--repo <id>] [--base <ref>] [--cwd <path>] [--ignore <globs>] [--summarize-only <globs>]",
    "       [--budget <tokens>] [--json]",
    "                                                          Render the diff/inventory the reviewer would see (debug view)",
    "                                                          (works in any git checkout; shows whatever state the caller prepared —",
    "                                                          never fetches, checks out, or mutates the working tree)",
    "  version                                                Show the installed CLI version",
    "",
    "Secrets:",
    "  - Service-owned webhook secret via systemd credential `review-quill-webhook-secret`",
    "  - REVIEW_QUILL_GITHUB_APP_ID in service.env + systemd credential `review-quill-github-app-pem`",
    "",
    "Review protocol:",
    "  - review-quill submits ordinary GitHub `APPROVE` / `REQUEST_CHANGES` reviews with its App identity",
    "",
    "Command help:",
    "  review-quill help",
    "  review-quill help repo",
    "  review-quill help service",
  ].join("\n");
}

function repoHelpText(): string {
  return [
    "Usage:",
    "  review-quill repo attach <owner/repo> [options]",
    "  review-quill repo attach <id> <owner/repo> [options]",
    "  review-quill repo list [--json]",
    "  review-quill repo show <id> [--json]",
    "",
    "Options for `repo attach`:",
    "  --base-branch <branch>       Base branch to review against (default: GitHub default branch or main)",
    "  --required-check <checks>    Comma-separated required check names",
    "  --review-doc <paths>         Comma-separated repo docs to provide to the reviewer",
    "  --refresh                    Re-discover base branch and required checks from GitHub",
    "  --json                       Emit structured JSON",
    "",
    "Compatibility aliases:",
    "  review-quill attach ...      Alias for `review-quill repo attach ...`",
    "  review-quill repos ...       Alias for `review-quill repo list/show ...`",
    "",
    "Examples:",
    "  review-quill repo attach krasnoperov/mafia",
    "  review-quill repo attach mafia krasnoperov/mafia --refresh",
    "  review-quill repo list",
    "  review-quill repo show mafia",
    "",
    "Review contract:",
    "  - review-quill leaves a descriptive APPROVE / REQUEST_CHANGES review on the PR timeline",
  ].join("\n");
}

function serviceHelpText(): string {
  return [
    "Usage:",
    "  review-quill service <command> [options]",
    "",
    "Commands:",
    "  install [--force] [--json]    Reinstall the systemd unit",
    "  restart [--json]              Reload-or-restart the service",
    "  status [--json]               Show systemd state and local service health",
    "  logs [--lines <count>] [--json]",
    "                                Show recent journal logs",
  ].join("\n");
}

function helpTextFor(topic: HelpTopic): string {
  switch (topic) {
    case "repo":
      return repoHelpText();
    case "service":
      return serviceHelpText();
    default:
      return rootHelpText();
  }
}

function writeOutput(stream: Output, text: string): void {
  stream.write(text);
}

function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function withAttemptState(attempt: ReviewAttemptRecord, config: ReviewQuillConfig): ReviewAttemptRecord {
  return decorateAttempt(attempt, {
    policy: {
      queuedAfterMs: config.reconciliation.staleQueuedAfterMs,
      runningAfterMs: config.reconciliation.staleRunningAfterMs,
    },
  });
}

function writeUsageError(stream: Output, error: UsageError): void {
  writeOutput(stream, `${helpTextFor(error.helpTopic)}\n\nError: ${error.message}\n`);
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (value === "-h" || value === "--help") {
      flags.set("help", true);
      continue;
    }
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    const [name, inline] = value.slice(2).split("=", 2);
    if (!name) continue;
    if (inline !== undefined) {
      flags.set(name, inline);
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      flags.set(name, next);
      index += 1;
      continue;
    }
    flags.set(name, true);
  }

  return { positionals, flags };
}

function hasHelpFlag(parsed: ParsedArgs): boolean {
  return parsed.flags.get("help") === true;
}

function assertKnownFlags(parsed: ParsedArgs, helpTopic: HelpTopic, allowedFlags: string[]): void {
  const allowed = new Set(["help", ...allowedFlags]);
  const unknownFlags = [...parsed.flags.keys()].filter((flag) => !allowed.has(flag)).sort();
  if (unknownFlags.length === 0) return;
  throw new UsageError(`Unknown flag${unknownFlags.length === 1 ? "" : "s"}: ${unknownFlags.map((flag) => `--${flag}`).join(", ")}`, helpTopic);
}

function validateFlags(parsed: ParsedArgs): void {
  const command = parsed.positionals[0] ?? "help";
  const subcommand = parsed.positionals[1];

  switch (command) {
    case "help":
      assertKnownFlags(parsed, "root", []);
      return;
    case "version":
    case "serve":
      assertKnownFlags(parsed, "root", ["config"]);
      return;
    case "watch":
    case "dashboard":
      assertKnownFlags(parsed, "root", ["config"]);
      return;
    case "init":
      assertKnownFlags(parsed, "root", ["force", "json"]);
      return;
    case "attach":
      assertKnownFlags(parsed, "repo", ["base-branch", "required-check", "review-doc", "refresh", "json"]);
      return;
    case "repos":
      assertKnownFlags(parsed, "repo", ["json"]);
      return;
    case "repo":
      switch (subcommand) {
        case undefined:
        case "list":
        case "show":
          assertKnownFlags(parsed, "repo", ["json"]);
          return;
        case "attach":
          assertKnownFlags(parsed, "repo", ["base-branch", "required-check", "review-doc", "refresh", "json"]);
          return;
        default:
          assertKnownFlags(parsed, "repo", []);
          return;
      }
    case "doctor":
      assertKnownFlags(parsed, "root", ["repo", "json"]);
      return;
    case "attempts":
      assertKnownFlags(parsed, "root", ["json"]);
      return;
    case "transcript":
      assertKnownFlags(parsed, "root", ["attempt", "json"]);
      return;
    case "diff":
      assertKnownFlags(parsed, "root", [
        "repo",
        "base",
        "cwd",
        "ignore",
        "summarize-only",
        "budget",
        "json",
      ]);
      return;
    case "service":
      switch (subcommand) {
        case "install":
          assertKnownFlags(parsed, "service", ["force", "json"]);
          return;
        case "restart":
          assertKnownFlags(parsed, "service", ["json"]);
          return;
        case "status":
          assertKnownFlags(parsed, "service", ["json"]);
          return;
        case "logs":
          assertKnownFlags(parsed, "service", ["lines", "json"]);
          return;
        default:
          assertKnownFlags(parsed, "service", []);
          return;
      }
    default:
      assertKnownFlags(parsed, "root", []);
  }
}

function parseConfigPath(args: string[]): string | undefined {
  const index = args.findIndex((value) => value === "--config");
  if (index === -1) return undefined;
  return args[index + 1];
}

function parseCsvFlag(value: string | boolean | undefined): string[] {
  if (typeof value !== "string") return [];
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function parseIntegerFlag(value: string | boolean | undefined, label: string): number | undefined {
  if (typeof value !== "string") return undefined;
  if (!/^\d+$/.test(value.trim())) {
    throw new UsageError(`${label} must be a positive integer.`);
  }
  return Number(value.trim());
}

function normalizePublicBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/$/, "");
  if (!/^https?:\/\//.test(trimmed)) {
    throw new UsageError(`Public base URL must include http:// or https://. Received: ${value}`);
  }
  return trimmed;
}

function parsePullRequestNumber(value: string | undefined): number {
  if (!value?.trim()) {
    throw new UsageError("review-quill attempts requires <repo> <pr-number>.");
  }
  if (!/^\d+$/.test(value.trim())) {
    throw new UsageError(`PR number must be a positive integer. Received: ${value}`);
  }
  return Number(value.trim());
}

function deriveRepoId(repoFullName: string): string {
  const repoName = repoFullName.split("/")[1]?.trim().toLowerCase() ?? "";
  const normalized = repoName
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[^a-z0-9]+$/, "");
  if (!normalized) {
    throw new UsageError(`Could not derive a repo id from ${repoFullName}. Pass an explicit <id>.`, "repo");
  }
  return normalized;
}

function parseAttachTarget(parsed: ParsedArgs): { repoId: string; repoFullName: string } {
  const first = parsed.positionals[1];
  const second = parsed.positionals[2];
  if (!first) {
    throw new UsageError("review-quill attach requires <owner/repo> or <id> <owner/repo>.", "repo");
  }
  if (second) {
    return { repoId: first, repoFullName: second };
  }
  if (!first.includes("/")) {
    throw new UsageError("review-quill attach requires <owner/repo> or <id> <owner/repo>.", "repo");
  }

  const existing = listRepoConfigs().find((repo) => repo.repoFullName === first);
  if (existing) {
    return { repoId: existing.repoId, repoFullName: first };
  }

  const repoId = deriveRepoId(first);
  const conflict = listRepoConfigs().find((repo) => repo.repoId === repoId && repo.repoFullName !== first);
  if (conflict) {
    throw new UsageError(`Derived repo id '${repoId}' is already used by ${conflict.repoFullName}. Pass an explicit <id>.`, "repo");
  }
  return { repoId, repoFullName: first };
}

function rewriteParsedArgs(parsed: ParsedArgs, positionals: string[]): ParsedArgs {
  return {
    positionals,
    flags: parsed.flags,
  };
}

function runGhApiJson<T>(pathArg: string): T {
  const result = defaultGhCommand(["api", pathArg]);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `gh api ${pathArg} failed`);
  }
  return JSON.parse(result.stdout) as T;
}

function runGhGraphqlJson<T>(query: string, variables: Record<string, string>): T {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [name, value] of Object.entries(variables)) {
    args.push("-f", `${name}=${value}`);
  }
  const result = defaultGhCommand(args);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || "gh api graphql failed");
  }
  return JSON.parse(result.stdout) as T;
}

function defaultGhCommand(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const result = spawnSync("gh", args, { encoding: "utf8" });
  if (result.error) {
    throw result.error;
  }
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function discoverRepoSettingsViaGhCli(repoFullName: string, branch?: string): {
  defaultBranch: string;
  branch: string;
  requiredChecks: string[];
} {
  const repo = runGhApiJson<GhRepoResponse>(`repos/${repoFullName}`);
  const targetBranch = branch?.trim() || repo.default_branch?.trim() || "main";
  const requiredChecks = new Set<string>();
  try {
    const protection = runGhApiJson<GhBranchProtectionResponse>(`repos/${repoFullName}/branches/${targetBranch}/protection`);
    for (const context of protection.required_status_checks?.contexts ?? []) {
      const trimmed = context?.trim();
      if (trimmed) requiredChecks.add(trimmed);
    }
    for (const check of protection.required_status_checks?.checks ?? []) {
      const trimmed = check.context?.trim();
      if (trimmed) requiredChecks.add(trimmed);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("404")) {
      throw error;
    }
  }

  return {
    defaultBranch: repo.default_branch?.trim() || targetBranch,
    branch: targetBranch,
    requiredChecks: [...requiredChecks].sort((left, right) => left.localeCompare(right)),
  };
}

function splitRepoFullName(repoFullName: string): { owner: string; name: string } {
  const [owner, name] = repoFullName.split("/", 2);
  if (!owner || !name) {
    throw new Error(`Invalid GitHub repository name: ${repoFullName}`);
  }
  return { owner, name };
}

function queryReviewGateState(repoFullName: string): GhReviewGateResponse {
  const { owner, name } = splitRepoFullName(repoFullName);
  return runGhGraphqlJson<GhReviewGateResponse>(
    `query($owner:String!, $name:String!) {
      repository(owner:$owner, name:$name) {
        pullRequests(first:20, states:OPEN, orderBy:{field:UPDATED_AT, direction:DESC}) {
          nodes {
            number
            reviewDecision
            headRefOid
            latestReviews(first:20) {
              nodes {
                state
                author { login }
                authorCanPushToRepository
                commit { oid }
              }
            }
          }
        }
      }
    }`,
    { owner, name },
  );
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
      commitOid: review.commit?.oid,
      headSha: pr.headRefOid,
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

async function handleInit(parsed: ParsedArgs, stdout: Output, runCommand: CommandRunner): Promise<number> {
  const target = parsed.positionals[1];
  if (!target) {
    throw new UsageError("review-quill init requires <public-base-url>.");
  }
  const publicBaseUrl = normalizePublicBaseUrl(target);
  const home = await initializeReviewQuillHome({
    publicBaseUrl,
    force: parsed.flags.get("force") === true,
  });
  const unit = await installServiceUnit({ force: parsed.flags.get("force") === true });
  const reloadState = await runSystemctl(runCommand, ["daemon-reload"]);
  const webhookUrl = `${publicBaseUrl}/webhooks/github`;

  const payload = {
    ...home,
    unitPath: unit.unitPath,
    serviceUnitStatus: unit.status,
    webhookUrl,
    serviceReloaded: reloadState.ok,
    ...(reloadState.ok ? {} : { serviceReloadError: reloadState.error }),
  };

  if (parsed.flags.get("json") === true) {
    writeOutput(stdout, formatJson(payload));
    return reloadState.ok ? 0 : 1;
  }

  writeOutput(
    stdout,
    [
      `Config directory: ${home.configDir}`,
      `Runtime env: ${home.runtimeEnvPath} (${home.runtimeEnvStatus})`,
      `Service env: ${home.serviceEnvPath} (${home.serviceEnvStatus})`,
      `Home config: ${home.configPath} (${home.configStatus})`,
      `State directory: ${home.stateDir}`,
      `Data directory: ${home.dataDir}`,
      `Systemd unit: ${unit.unitPath} (${unit.status})`,
      "",
      "Public URLs:",
      `- Base URL: ${publicBaseUrl}`,
      `- Webhook URL: ${webhookUrl}`,
      "",
      reloadState.ok ? "systemd daemon-reload completed." : `systemd daemon-reload failed: ${reloadState.error}`,
      "",
      "Next steps:",
      `1. Put REVIEW_QUILL_GITHUB_APP_ID into ${home.serviceEnvPath}`,
      "2. Install the webhook secret and GitHub App private key via systemd-creds",
      "3. Run `review-quill attach <owner/repo>`",
      "4. Configure your GitHub App webhook URL to the webhook URL above",
      "5. Run `review-quill doctor --repo <id>`",
    ].join("\n") + "\n",
  );
  return reloadState.ok ? 0 : 1;
}

async function handleAttach(parsed: ParsedArgs, stdout: Output, runCommand: CommandRunner): Promise<number> {
  const { repoId, repoFullName } = parseAttachTarget(parsed);
  const existing = listRepoConfigs().find((repo) => repo.repoId === repoId || repo.repoFullName === repoFullName);
  const explicitBaseBranch = typeof parsed.flags.get("base-branch") === "string" ? String(parsed.flags.get("base-branch")) : undefined;
  const explicitRequiredChecks = parseCsvFlag(parsed.flags.get("required-check"));
  const explicitReviewDocs = parseCsvFlag(parsed.flags.get("review-doc"));
  const refresh = parsed.flags.get("refresh") === true;

  const shouldDiscoverBaseBranch = !explicitBaseBranch && (!existing || refresh);
  const shouldDiscoverRequiredChecks = explicitRequiredChecks.length === 0 && (!existing || refresh || !!explicitBaseBranch);
  const needsDiscovery = shouldDiscoverBaseBranch || shouldDiscoverRequiredChecks;
  const warnings: string[] = [];
  let discovered:
    | {
      defaultBranch: string;
      branch: string;
      requiredChecks: string[];
    }
    | undefined;

  if (needsDiscovery) {
    try {
      discovered = discoverRepoSettingsViaGhCli(repoFullName, explicitBaseBranch ?? existing?.baseBranch);
    } catch (error) {
      warnings.push(`Could not discover GitHub defaults via gh: ${error instanceof Error ? error.message : String(error)}. Using local defaults instead.`);
    }
  }

  const result = await upsertRepoConfig({
    id: repoId,
    repoFullName,
    ...((explicitBaseBranch ?? discovered?.branch) ? { baseBranch: explicitBaseBranch ?? discovered?.branch ?? "main" } : {}),
    ...(explicitRequiredChecks.length > 0 ? { requiredChecks: explicitRequiredChecks } : discovered ? { requiredChecks: discovered.requiredChecks } : {}),
    ...(explicitReviewDocs.length > 0 ? { reviewDocs: explicitReviewDocs } : {}),
  });

  const restartState = await runSystemctl(runCommand, ["reload-or-restart", "review-quill.service"]);

  if (parsed.flags.get("json") === true) {
    writeOutput(stdout, formatJson({
      ...result,
      serviceRestarted: restartState.ok,
      ...(restartState.ok ? {} : { errors: [restartState.error] }),
      ...(warnings.length > 0 ? { warnings } : {}),
    }));
    return restartState.ok ? 0 : 1;
  }

  writeOutput(
    stdout,
    [
      `Repo config: ${result.configPath}`,
      `${result.status === "created" ? "Attached" : result.status === "updated" ? "Updated" : "Verified"} repo ${result.repo.repoId} for ${result.repo.repoFullName}`,
      `Base branch: ${result.repo.baseBranch}`,
      `Required checks: ${result.repo.requiredChecks.length > 0 ? result.repo.requiredChecks.join(", ") : "(any green check)"}`,
      `Review docs: ${result.repo.reviewDocs.join(", ")}`,
      `Summarize-only diff patterns: ${result.repo.diffSummarizeOnly.join(", ") || "(none)"}`,
      `Ignored diff patterns: ${result.repo.diffIgnore.join(", ") || "(none)"}`,
      `Patch body budget: ${result.repo.patchBodyBudgetTokens} tokens`,
      ...warnings.map((warning) => `Warning: ${warning}`),
      restartState.ok ? "Restarted review-quill.service" : `Restart failed: ${restartState.error}`,
    ].join("\n") + "\n",
  );
  return restartState.ok ? 0 : 1;
}

async function handleRepos(parsed: ParsedArgs, stdout: Output): Promise<number> {
  const repoId = parsed.positionals[1];
  if (!repoId) {
    const repos = listRepoConfigs();
    if (parsed.flags.get("json") === true) {
      writeOutput(stdout, formatJson({ repos }));
      return 0;
    }
    if (repos.length === 0) {
      writeOutput(stdout, "No watched repositories yet. Run `review-quill attach <owner/repo>`.\n");
      return 0;
    }
    writeOutput(
      stdout,
      repos
        .map((repo) => `${repo.repoId}  ${repo.repoFullName}  base=${repo.baseBranch}`)
        .join("\n") + "\n",
    );
    return 0;
  }

  const { configPath, repo, publicBaseUrl } = loadRepoConfigById(repoId);
  const webhookUrl = publicBaseUrl ? `${publicBaseUrl.replace(/\/$/, "")}/webhooks/github` : undefined;
  const payload = {
    repoId: repo.repoId,
    repoFullName: repo.repoFullName,
    baseBranch: repo.baseBranch,
    requiredChecks: repo.requiredChecks,
    excludeBranches: repo.excludeBranches,
    reviewDocs: repo.reviewDocs,
    diffIgnore: repo.diffIgnore,
    diffSummarizeOnly: repo.diffSummarizeOnly,
    patchBodyBudgetTokens: repo.patchBodyBudgetTokens,
    configPath,
    ...(webhookUrl ? { webhookUrl } : {}),
  };

  if (parsed.flags.get("json") === true) {
    writeOutput(stdout, formatJson(payload));
    return 0;
  }

  writeOutput(
    stdout,
    [
      `Repo: ${repo.repoId}`,
      `GitHub repo: ${repo.repoFullName}`,
      `Config path: ${configPath}`,
      `Base branch: ${repo.baseBranch}`,
      `Required checks: ${repo.requiredChecks.length > 0 ? repo.requiredChecks.join(", ") : "(any green check)"}`,
      `Exclude branches: ${repo.excludeBranches.join(", ")}`,
      `Review docs: ${repo.reviewDocs.join(", ")}`,
      `Summarize-only diff patterns: ${repo.diffSummarizeOnly.join(", ") || "(none)"}`,
      `Ignored diff patterns: ${repo.diffIgnore.join(", ") || "(none)"}`,
      `Patch body budget: ${repo.patchBodyBudgetTokens} tokens`,
      webhookUrl ? `Webhook URL: ${webhookUrl}` : undefined,
    ].filter(Boolean).join("\n") + "\n",
  );
  return 0;
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

async function handleDoctor(parsed: ParsedArgs, stdout: Output, runCommand: CommandRunner): Promise<number> {
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
          status: checksMatch ? "pass" : "warn",
          scope: `repo:${repo.repoId}:github-required-checks`,
          message: checksMatch
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

type DiffConfigSource = "explicit" | "watched" | "defaults";

interface DiffConfigResolution {
  repo: ReviewQuillRepositoryConfig;
  source: DiffConfigSource;
  detectedRepoFullName?: string;
}

function safeListWatchedRepos(): ReviewQuillRepositoryConfig[] {
  try {
    return listRepoConfigs() as ReviewQuillRepositoryConfig[];
  } catch {
    return [];
  }
}

async function resolveDiffRepoConfig(params: {
  cwd: string;
  explicitRepo?: string;
}): Promise<DiffConfigResolution> {
  if (params.explicitRepo) {
    return { repo: loadRepoConfigById(params.explicitRepo).repo as ReviewQuillRepositoryConfig, source: "explicit" };
  }
  const detected = await detectRepoFullNameFromCwd(params.cwd);
  if (detected) {
    const match = safeListWatchedRepos().find(
      (entry) => entry.repoFullName.toLowerCase() === detected.toLowerCase(),
    );
    if (match) {
      return { repo: match, source: "watched", detectedRepoFullName: detected };
    }
  }
  const defaultBranch = await detectDefaultBranch(params.cwd);
  return {
    repo: defaultDiffRepoConfig(detected, defaultBranch),
    source: "defaults",
    ...(detected ? { detectedRepoFullName: detected } : {}),
  };
}

function applyDiffConfigOverrides(
  base: ReviewQuillRepositoryConfig,
  parsed: ParsedArgs,
): ReviewQuillRepositoryConfig {
  const next: ReviewQuillRepositoryConfig = { ...base };
  const ignore = parsed.flags.get("ignore");
  if (typeof ignore === "string") next.diffIgnore = parseCsvFlag(ignore);
  const summarize = parsed.flags.get("summarize-only");
  if (typeof summarize === "string") next.diffSummarizeOnly = parseCsvFlag(summarize);
  const budget = parseIntegerFlag(parsed.flags.get("budget"), "--budget");
  if (budget !== undefined) next.patchBodyBudgetTokens = budget;
  return next;
}

async function handleDiff(parsed: ParsedArgs, stdout: Output): Promise<number> {
  const explicitRepo = typeof parsed.flags.get("repo") === "string" ? String(parsed.flags.get("repo")) : undefined;
  const explicitBase = typeof parsed.flags.get("base") === "string" ? String(parsed.flags.get("base")) : undefined;
  const explicitCwd = typeof parsed.flags.get("cwd") === "string" ? String(parsed.flags.get("cwd")) : undefined;
  const json = parsed.flags.get("json") === true;
  const cwd = explicitCwd ?? process.cwd();

  const resolution = await resolveDiffRepoConfig({ cwd, ...(explicitRepo ? { explicitRepo } : {}) });
  const repo = applyDiffConfigOverrides(resolution.repo, parsed);

  // This command is a read-only debug view of whatever git state the
  // caller prepared. It never fetches, checks out, or mutates the
  // working tree — if the caller wants fresh refs, they run `git fetch`
  // themselves before invoking `review-quill diff`.
  const { workspace, diff } = await buildLocalDiffContext({
    repo,
    cwd,
    ...(explicitBase ? { baseRef: explicitBase } : {}),
  });

  const body = renderDiffContextLines(diff);

  if (json) {
    // JSON mode keeps all diagnostic fields — budget, repo resolution,
    // workspace refs — for scripting and debugging. Plain-text mode
    // stays pure (only the bytes that would land in the prompt) so
    // callers can compare the CLI output byte-for-byte against what
    // the reviewer will see.
    const diffSectionTokens = estimateTokens(body.join("\n"));
    const patchBodyTokens = diff.patches.reduce(
      (sum, entry) => sum + estimateTokens(entry.patch) + 23, // framing overhead
      0,
    );
    writeOutput(stdout, formatJson({
      configSource: resolution.source,
      ...(resolution.detectedRepoFullName ? { detectedRepoFullName: resolution.detectedRepoFullName } : {}),
      repo: {
        repoId: repo.repoId,
        repoFullName: repo.repoFullName,
        baseBranch: repo.baseBranch,
        diffIgnore: repo.diffIgnore,
        diffSummarizeOnly: repo.diffSummarizeOnly,
        patchBodyBudgetTokens: repo.patchBodyBudgetTokens,
      },
      workspace,
      estimatedTokens: {
        patchBody: patchBodyTokens,
        patchBodyBudget: repo.patchBodyBudgetTokens,
        fullDiffSection: diffSectionTokens,
      },
      diff,
    }));
    return 0;
  }

  // Plain-text mode: emit ONLY the bytes the prompt-builder will embed
  // via renderDiffContextLines. No repository header, no budget line, no
  // base/head ref, no SHA. If the caller wants those diagnostics they
  // can run `review-quill diff --json` instead.
  writeOutput(stdout, `${body.join("\n")}\n`);
  return 0;
}

async function handleAttempts(parsed: ParsedArgs, stdout: Output): Promise<number> {
  const repoRef = parsed.positionals[1];
  const prNumber = parsePullRequestNumber(parsed.positionals[2]);
  if (!repoRef) {
    throw new UsageError("review-quill attempts requires <repo> <pr-number>.");
  }

  const configPath = process.env.REVIEW_QUILL_CONFIG ?? getDefaultConfigPath();
  const config = loadConfig(configPath);
  const { repo } = loadRepoConfigById(repoRef);
  const store = new SqliteStore(config.database.path);
  try {
    const attempts = store.listAttemptsForPullRequest(repo.repoFullName, prNumber, 50)
      .map((attempt) => withAttemptState(attempt, config));
    const payload = {
      repoId: repo.repoId,
      repoFullName: repo.repoFullName,
      prNumber,
      attempts,
    };

    if (parsed.flags.get("json") === true) {
      writeOutput(stdout, formatJson(payload));
      return 0;
    }

    const lines = [
      `Repo: ${repo.repoFullName}`,
      `PR: #${prNumber}`,
      `Attempts: ${attempts.length}`,
    ];

    if (attempts.length === 0) {
      lines.push("");
      lines.push("No recorded review attempts.");
      writeOutput(stdout, `${lines.join("\n")}\n`);
      return 0;
    }

    lines.push("");
    lines.push("Review workspaces are disposable temp worktrees, so old attempts expose Codex thread ids rather than a stable reopen path.");

    for (const attempt of attempts) {
      lines.push("");
      lines.push(
        [
          `attempt #${attempt.id}`,
          attempt.stale ? "stale" : undefined,
          attempt.status,
          attempt.conclusion ?? undefined,
          attempt.completedAt ? `${attempt.createdAt} -> ${attempt.completedAt}` : `${attempt.createdAt} -> running`,
        ].filter(Boolean).join("  "),
      );
      lines.push(`Head SHA: ${attempt.headSha}`);
      if (attempt.threadId) {
        lines.push(`Thread: ${attempt.threadId}`);
        lines.push(`Catalog: search Codex old sessions for thread ${attempt.threadId}`);
      }
      if (attempt.turnId) {
        lines.push(`Turn: ${attempt.turnId}`);
      }
      if (attempt.externalCheckRunId !== undefined) {
        lines.push(`Check run: ${attempt.externalCheckRunId}`);
      }
      lines.push(`Updated: ${attempt.updatedAt}`);
      if (attempt.staleReason) {
        lines.push(`Stale: ${attempt.staleReason}`);
      }
      lines.push(`Summary: ${attempt.summary ?? "No summary captured."}`);
    }

    writeOutput(stdout, `${lines.join("\n")}\n`);
    return 0;
  } finally {
    store.close();
  }
}

function parseAttemptId(value: string | boolean | undefined): number | undefined {
  if (value === undefined || value === false) {
    return undefined;
  }
  if (value === true || typeof value !== "string" || !/^\d+$/.test(value.trim())) {
    throw new UsageError(`Attempt id must be a positive integer. Received: ${String(value)}`);
  }
  return Number(value.trim());
}

function selectTranscriptAttempt(
  attempts: ReviewAttemptRecord[],
  attemptId?: number,
): { attempt: ReviewAttemptRecord; notice?: string } {
  if (attemptId !== undefined) {
    const match = attempts.find((attempt) => attempt.id === attemptId);
    if (!match) {
      throw new UsageError(`No recorded review attempt #${attemptId} for that pull request.`);
    }
    return { attempt: match };
  }

  const latest = attempts[0];
  const withThread = attempts.find((attempt) => attempt.threadId);
  if (withThread) {
    return {
      attempt: withThread,
      ...(latest && latest.id !== withThread.id && latest.stale && !latest.threadId
        ? {
          notice: `Newest attempt #${latest.id} is stale and has no stored Codex thread. Showing latest attempt with a stored thread instead (#${withThread.id}).`,
        }
        : {}),
    };
  }

  if (latest?.stale) {
    throw new UsageError(`Newest attempt #${latest.id} is stale and has no stored Codex thread. ${latest.staleReason ?? ""}`.trim());
  }

  throw new UsageError("No recorded review attempt with a stored Codex thread was found for that pull request.");
}

function formatTranscriptText(params: {
  repoFullName: string;
  prNumber: number;
  attempt: ReviewAttemptRecord;
  thread: CodexThreadSummary;
  notice?: string;
}): string {
  const formatUserMessage = (item: Record<string, unknown>): string | undefined => {
    const content = item.content;
    if (!Array.isArray(content)) {
      return undefined;
    }

    const textParts = content
      .map((entry) => {
        if (!entry || typeof entry !== "object") {
          return undefined;
        }
        const value = (entry as Record<string, unknown>).text;
        return typeof value === "string" ? value : undefined;
      })
      .filter((value): value is string => Boolean(value));

    return textParts.length > 0 ? textParts.join("\n\n") : undefined;
  };

  const compactExtraFields = (item: Record<string, unknown>, ignored: string[]): string | undefined => {
    const filtered = Object.fromEntries(
      Object.entries(item).filter(([key, value]) => !ignored.includes(key) && value !== undefined),
    );
    return Object.keys(filtered).length > 0 ? JSON.stringify(filtered, null, 2) : undefined;
  };

  const lines = [
    `Repo: ${params.repoFullName}`,
    `PR: #${params.prNumber}`,
    `Attempt: #${params.attempt.id}`,
    `Status: ${params.attempt.status}${params.attempt.conclusion ? ` (${params.attempt.conclusion})` : ""}`,
    `Head SHA: ${params.attempt.headSha}`,
    `Thread: ${params.thread.id}`,
    params.attempt.turnId ? `Recorded turn: ${params.attempt.turnId}` : undefined,
    params.attempt.staleReason ? `Stale: ${params.attempt.staleReason}` : undefined,
    params.notice,
    "Visible thread items are shown below. Hidden model reasoning is not exposed by the app-server.",
    "",
  ].filter(Boolean) as string[];

  for (const [index, turn] of params.thread.turns.entries()) {
    lines.push(`Turn ${index + 1}: ${turn.id} [${turn.status}]`);
    for (const item of turn.items) {
      if (item.type === "userMessage") {
        lines.push(`user (${item.id}):`);
        const record = item as Record<string, unknown>;
        lines.push(formatUserMessage(record) ?? JSON.stringify(item, null, 2));
        const extra = compactExtraFields(record, ["type", "id", "content"]);
        if (extra) {
          lines.push("meta:");
          lines.push(extra);
        }
      } else if (item.type === "agentMessage" && typeof item.text === "string") {
        const record = item as Record<string, unknown>;
        const phaseValue = record.phase;
        const phase = typeof phaseValue === "string" ? ` [${phaseValue}]` : "";
        lines.push(`assistant (${item.id})${phase}:`);
        lines.push(item.text);
        const extra = compactExtraFields(record, ["type", "id", "text", "phase"]);
        if (extra) {
          lines.push("meta:");
          lines.push(extra);
        }
      } else {
        const record = item as Record<string, unknown>;
        const toolName = typeof record.toolName === "string"
          ? record.toolName
          : typeof record.name === "string"
            ? record.name
            : undefined;
        lines.push(`item ${item.type} (${item.id})${toolName ? ` [${toolName}]` : ""}:`);
        lines.push(JSON.stringify(item, null, 2));
      }
      lines.push("");
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

async function handleTranscript(
  parsed: ParsedArgs,
  stdout: Output,
  readCodexThread?: (threadId: string) => Promise<CodexThreadSummary>,
): Promise<number> {
  const repoRef = parsed.positionals[1];
  const prNumber = parsePullRequestNumber(parsed.positionals[2]);
  if (!repoRef) {
    throw new UsageError("review-quill transcript requires <repo> <pr-number>.");
  }

  const configPath = process.env.REVIEW_QUILL_CONFIG ?? getDefaultConfigPath();
  const config = loadConfig(configPath);
  const { repo } = loadRepoConfigById(repoRef);
  const attemptId = parseAttemptId(parsed.flags.get("attempt"));
  const store = new SqliteStore(config.database.path);

  try {
    const attempts = store.listAttemptsForPullRequest(repo.repoFullName, prNumber, 50)
      .map((entry) => withAttemptState(entry, config));
    if (attempts.length === 0) {
      throw new UsageError("No recorded review attempts were found for that pull request.");
    }

    const selection = selectTranscriptAttempt(attempts, attemptId);
    const { attempt } = selection;
    if (!attempt.threadId) {
      throw new UsageError(
        `Review attempt #${attempt.id} does not have a stored Codex thread id.${attempt.staleReason ? ` ${attempt.staleReason}` : ""}`,
      );
    }

    const thread = readCodexThread
      ? await readCodexThread(attempt.threadId)
      : await (async () => {
        const client = new CodexAppServerClient(config.codex, pino({ level: "silent" }));
        await client.start();
        try {
          return await client.readThread(attempt.threadId!);
        } finally {
          await client.stop();
        }
      })();

    const payload = {
      repoId: repo.repoId,
      repoFullName: repo.repoFullName,
      prNumber,
      attempt,
      thread,
    };

    if (parsed.flags.get("json") === true) {
      writeOutput(stdout, formatJson(payload));
      return 0;
    }

    writeOutput(stdout, formatTranscriptText({
      repoFullName: repo.repoFullName,
      prNumber,
      attempt,
      thread,
      ...(selection.notice ? { notice: selection.notice } : {}),
    }));
    return 0;
  } finally {
    store.close();
  }
}

async function handleService(parsed: ParsedArgs, stdout: Output, runCommand: CommandRunner): Promise<number> {
  const subcommand = parsed.positionals[1];
  if (!subcommand) {
    throw new UsageError("review-quill service requires a subcommand.", "service");
  }

  if (subcommand === "install") {
    const result = await installServiceUnit({ force: parsed.flags.get("force") === true });
    const reload = await runSystemctl(runCommand, ["daemon-reload"]);
    if (parsed.flags.get("json") === true) {
      writeOutput(stdout, formatJson({
        ...result,
        daemonReloaded: reload.ok,
        ...(reload.ok ? {} : { error: reload.error }),
      }));
      return reload.ok ? 0 : 1;
    }
    writeOutput(
      stdout,
      [
        `Systemd unit: ${result.unitPath} (${result.status})`,
        reload.ok ? "systemd daemon-reload completed." : `systemd daemon-reload failed: ${reload.error}`,
      ].join("\n") + "\n",
    );
    return reload.ok ? 0 : 1;
  }

  if (subcommand === "restart") {
    const daemonReload = await runSystemctl(runCommand, ["daemon-reload"]);
    const restart = await runSystemctl(runCommand, ["reload-or-restart", "review-quill.service"]);
    if (parsed.flags.get("json") === true) {
      writeOutput(stdout, formatJson({
        daemonReloaded: daemonReload.ok,
        restarted: restart.ok,
        errors: [
          ...(daemonReload.ok ? [] : [daemonReload.error]),
          ...(restart.ok ? [] : [restart.error]),
        ],
      }));
      return daemonReload.ok && restart.ok ? 0 : 1;
    }
    writeOutput(
      stdout,
      [
        daemonReload.ok ? "systemd daemon-reload completed." : `systemd daemon-reload failed: ${daemonReload.error}`,
        restart.ok ? "Restarted review-quill.service" : `Restart failed: ${restart.error}`,
      ].join("\n") + "\n",
    );
    return daemonReload.ok && restart.ok ? 0 : 1;
  }

  if (subcommand === "status") {
    const status = await runSystemctl(runCommand, [
      "show",
      "review-quill.service",
      "--property=Id,LoadState,UnitFileState,ActiveState,SubState,FragmentPath,ExecMainPID",
    ]);
    if (!status.ok) {
      throw new Error(status.error);
    }
    const properties = parseSystemctlShowOutput(status.result.stdout);
    let health:
      | { ok: boolean; service: string; repos: string[] }
      | undefined;
    let watch:
      | {
        summary: {
          totalRepos: number;
          totalAttempts: number;
          queuedAttempts: number;
          runningAttempts: number;
          completedAttempts: number;
          failedAttempts: number;
        };
      }
      | undefined;
    let healthError: string | undefined;
    try {
      health = await fetchServiceHealth();
      watch = await fetchWatchSnapshot();
    } catch (error) {
      healthError = error instanceof Error ? error.message : String(error);
    }

    if (parsed.flags.get("json") === true) {
      writeOutput(stdout, formatJson({
        unit: "review-quill.service",
        systemd: properties,
        ...(health ? { health } : {}),
        ...(watch ? { watch: watch.summary } : {}),
        ...(healthError ? { healthError } : {}),
      }));
      return 0;
    }

    writeOutput(
      stdout,
      [
        `Unit: ${properties.Id ?? "review-quill.service"}`,
        `Load state: ${properties.LoadState ?? "unknown"}`,
        `Enabled: ${properties.UnitFileState ?? "unknown"}`,
        `Active: ${properties.ActiveState ?? "unknown"}${properties.SubState ? ` (${properties.SubState})` : ""}`,
        properties.ExecMainPID ? `Main PID: ${properties.ExecMainPID}` : undefined,
        health ? `Health: ok (${health.repos.length} repos)` : `Health: unavailable (${healthError ?? "unknown error"})`,
        watch ? `Attempts: total=${watch.summary.totalAttempts} running=${watch.summary.runningAttempts} failed=${watch.summary.failedAttempts}` : undefined,
      ].filter(Boolean).join("\n") + "\n",
    );
    return 0;
  }

  if (subcommand === "logs") {
    const lines = parseIntegerFlag(parsed.flags.get("lines"), "--lines") ?? 50;
    const result = await runCommand("sudo", [
      "journalctl", "-u", "review-quill.service", "-n", String(lines), "--no-pager", "-o", "short-iso",
    ]);
    if (result.exitCode !== 0) {
      throw new Error(formatCommandFailure(result, "Unable to read logs for review-quill.service."));
    }
    if (parsed.flags.get("json") === true) {
      writeOutput(stdout, formatJson({
        unit: "review-quill.service",
        lines,
        logs: result.stdout.split(/\r?\n/).filter(Boolean),
      }));
      return 0;
    }
    writeOutput(stdout, `${result.stdout}${result.stdout.endsWith("\n") || result.stdout.length === 0 ? "" : "\n"}`);
    return 0;
  }

  throw new UsageError(`Unknown service command: ${subcommand}`, "service");
}

export async function runCli(args: string[], options?: RunCliOptions): Promise<number> {
  const stdout = options?.stdout ?? process.stdout;
  const stderr = options?.stderr ?? process.stderr;
  const runCommand = options?.runCommand ?? defaultRunCommand;

  try {
    const parsed = parseArgs(args);

    if (parsed.flags.get("version") === true || parsed.positionals[0] === "version") {
      const { version } = await import("../package.json", { with: { type: "json" } }).then((module) => module.default);
      writeOutput(stdout, `review-quill ${version}\n`);
      return 0;
    }

    validateFlags(parsed);
    const command = parsed.positionals[0] ?? "help";

    if (hasHelpFlag(parsed) || command === "help") {
      const topic = command === "help"
        ? ((parsed.positionals[1] as HelpTopic | "attach" | "dashboard" | "repos" | "watch" | undefined) ?? "root")
        : (command === "attach" || command === "repo" || command === "repos"
            ? "repo"
            : command === "service"
              ? "service"
              : "root");
      if (!["root", "attach", "dashboard", "repo", "repos", "watch", "service"].includes(topic)) {
        throw new UsageError(`Unknown help topic: ${String(topic)}`);
      }
      writeOutput(stdout, `${helpTextFor(topic === "attach" || topic === "repos" ? "repo" : topic === "dashboard" || topic === "watch" ? "root" : topic)}\n`);
      return 0;
    }

    switch (command) {
      case "serve": {
        const configPath = parseConfigPath(args.slice(1)) ?? process.env.REVIEW_QUILL_CONFIG ?? getDefaultConfigPath();
        const { startServer } = await import("./server.ts");
        await startServer(configPath);
        return 0;
      }
      case "watch":
      case "dashboard": {
        const configPath = parseConfigPath(args.slice(1)) ?? process.env.REVIEW_QUILL_CONFIG ?? getDefaultConfigPath();
        const { startWatch } = await import("./watch/index.tsx");
        await startWatch(configPath);
        return 0;
      }
      case "init":
        return await handleInit(parsed, stdout, runCommand);
      case "attach":
        return await handleAttach(parsed, stdout, runCommand);
      case "repos":
        return await handleRepos(parsed, stdout);
      case "repo": {
        const subcommand = parsed.positionals[1] ?? "list";
        if (subcommand === "attach") {
          return await handleAttach(rewriteParsedArgs(parsed, ["attach", ...parsed.positionals.slice(2)]), stdout, runCommand);
        }
        if (subcommand === "list") {
          return await handleRepos(rewriteParsedArgs(parsed, ["repos", ...parsed.positionals.slice(2)]), stdout);
        }
        if (subcommand === "show") {
          if (!parsed.positionals[2]) {
            throw new UsageError("review-quill repo show requires <id>.", "repo");
          }
          return await handleRepos(rewriteParsedArgs(parsed, ["repos", ...parsed.positionals.slice(2)]), stdout);
        }
        throw new UsageError(`Unknown repo command: ${subcommand}`, "repo");
      }
      case "doctor":
        return await handleDoctor(parsed, stdout, runCommand);
      case "attempts":
        return await handleAttempts(parsed, stdout);
      case "transcript":
        return await handleTranscript(parsed, stdout, options?.readCodexThread);
      case "diff":
        return await handleDiff(parsed, stdout);
      case "service":
        return await handleService(parsed, stdout, runCommand);
      default:
        throw new UsageError(`Unknown command: ${command}`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      writeUsageError(stderr, error);
      return 1;
    }
    writeOutput(stderr, `${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
