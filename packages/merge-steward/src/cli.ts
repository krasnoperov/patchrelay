import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig, parseConfig, type StewardConfig } from "./config.ts";
import { exec } from "./exec.ts";
import { initializeMergeStewardHome, installServiceUnit, upsertRepoConfig } from "./install.ts";
import {
  getDefaultConfigPath,
  getDefaultRepoConfigDir,
  getDefaultRuntimeEnvPath,
  getDefaultServiceEnvPath,
  getDefaultStateDir,
  getRepoConfigPath,
  getSystemdUnitTemplatePath,
} from "./runtime-paths.ts";
import { buildSummary } from "./service.ts";
import { resolveSecretWithSource } from "./resolve-secret.ts";
import { SqliteStore } from "./db/sqlite-store.ts";
import { parseHomeConfigObject } from "./steward-home.ts";
import type { QueueEntry, QueueEntryDetail, QueueWatchSnapshot } from "./types.ts";

interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string | boolean>;
}

type HelpTopic = "root" | "repos" | "service" | "queue";

interface Output {
  write(chunk: string): boolean;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>;

interface RunCliOptions {
  stdout?: Output;
  stderr?: Output;
  runCommand?: CommandRunner;
}

class UsageError extends Error {
  constructor(message: string, readonly helpTopic: HelpTopic = "root") {
    super(message);
    this.name = "UsageError";
  }
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
    const trimmed = value.slice(2);
    const [name, inline] = trimmed.split("=", 2);
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
  if (unknownFlags.length === 0) {
    return;
  }
  throw new UsageError(`Unknown flag${unknownFlags.length === 1 ? "" : "s"}: ${unknownFlags.map((flag) => `--${flag}`).join(", ")}`, helpTopic);
}

function validateFlags(parsed: ParsedArgs): void {
  const command = parsed.positionals[0] ?? "help";
  const subcommand = parsed.positionals[1];

  switch (command) {
    case "help":
      assertKnownFlags(parsed, "root", []);
      return;
    case "init":
      assertKnownFlags(parsed, "root", ["force", "json"]);
      return;
    case "doctor":
      assertKnownFlags(parsed, "root", ["repo", "json"]);
      return;
    case "serve":
      assertKnownFlags(parsed, "root", ["config", "repo"]);
      return;
    case "attach":
      assertKnownFlags(parsed, "repos", ["base-branch", "required-check", "label", "json"]);
      return;
    case "repos":
      assertKnownFlags(parsed, "repos", ["json"]);
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
    case "queue":
      switch (subcommand) {
        case "status":
          assertKnownFlags(parsed, "queue", ["repo", "events", "json"]);
          return;
        case "show":
          assertKnownFlags(parsed, "queue", ["repo", "entry", "pr", "events", "json"]);
          return;
        case "watch":
          assertKnownFlags(parsed, "queue", ["repo", "pr"]);
          return;
        case "reconcile":
          assertKnownFlags(parsed, "queue", ["repo", "json"]);
          return;
        default:
          assertKnownFlags(parsed, "queue", []);
          return;
      }
    default:
      assertKnownFlags(parsed, "root", []);
  }
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
  const candidate = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(value) ? value : `https://${value}`;
  return new URL(candidate).origin;
}

function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeOutput(stream: Output, text: string): void {
  stream.write(text);
}

function writeUsageError(stream: Output, error: UsageError): void {
  writeOutput(stream, `${helpTextFor(error.helpTopic)}\n\nError: ${error.message}\n`);
}

function readEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) {
    return {};
  }
  const raw = statSync(filePath).isFile() ? readFileSync(filePath, "utf8") : "";
  const values: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const name = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (name) {
      values[name] = value;
    }
  }
  return values;
}

function getHomeEnv(): Record<string, string | undefined> {
  return {
    ...readEnvFile(getDefaultRuntimeEnvPath()),
    ...readEnvFile(getDefaultServiceEnvPath()),
    ...process.env,
  };
}

function rootHelpText(): string {
  return [
    "merge-steward",
    "",
    "merge-steward is a repo-scoped merge queue service for PatchRelay-managed pull requests.",
    "",
    "Usage:",
    "  merge-steward <command> [args] [flags]",
    "",
    "Happy path:",
    "  1. merge-steward init <public-base-url>",
    "  2. merge-steward attach <id> <owner/repo> [--base-branch main] [--required-check test,lint]",
    "  3. merge-steward doctor --repo <id>",
    "  4. merge-steward service status <id>",
    "  5. merge-steward queue status --repo <id>",
    "",
    "Everyday commands:",
    "  attach <id> <owner/repo> [--base-branch <branch>] [--required-check <checks>] [--label <label>] [--json]",
    "                                                          Create or update one repo-scoped steward config and restart its service",
    "  repos [<id>] [--json]                                  List attached repositories or show one repo config and webhook URL",
    "  doctor [--repo <id>] [--json]                          Validate config, secrets, auth, and required binaries",
    "  service status <id> [--json]                           Show systemd state for one repo instance",
    "  service logs <id> [--lines <count>] [--json]           Show recent journal logs for one repo instance",
    "  queue status --repo <id> [--json]                      Show queue summary and current entries",
    "  queue show --repo <id> (--entry <id> | --pr <num>) [--events <count>] [--json]",
    "                                                          Show one queue entry with events and incidents",
    "  queue watch --repo <id> [--pr <number>]                Open the queue watch TUI",
    "",
    "Service management:",
    "  service install [--force] [--json]                     Reinstall the systemd instance unit template",
    "  service restart <id> [--json]                          Reload-or-restart one repo instance",
    "Advanced commands:",
    "  init <public-base-url> [--force] [--json]              Bootstrap the local merge-steward home and systemd template",
    "  serve [--config <path> | --repo <id>]                  Run the service",
    "  queue reconcile --repo <id> [--json]                   Ask the local service to reconcile immediately",
    "",
    "Secrets:",
    "  - MERGE_STEWARD_WEBHOOK_SECRET or systemd credential `merge-steward-webhook-secret`",
    "  - MERGE_STEWARD_GITHUB_TOKEN or systemd credential `merge-steward-github-token`",
    "",
    "Command help:",
    "  merge-steward help",
    "  merge-steward help repos",
    "  merge-steward help service",
    "  merge-steward help queue",
  ].join("\n");
}

function reposHelpText(): string {
  return [
    "Usage:",
    "  merge-steward attach <id> <owner/repo> [options]",
    "  merge-steward repos [<id>] [--json]",
    "",
    "Options for `attach`:",
    "  --base-branch <branch>       Base branch to land into (default: main)",
    "  --required-check <checks>    Comma-separated required check names",
    "  --label <label>              Admission label (default: queue)",
    "  --json                       Emit structured JSON",
    "",
    "Examples:",
    "  merge-steward attach app owner/repo --base-branch main --required-check test,lint",
    "  merge-steward repos",
    "  merge-steward repos app",
  ].join("\n");
}

function serviceHelpText(): string {
  return [
    "Usage:",
    "  merge-steward service <command> [args] [options]",
    "",
    "Commands:",
    "  install [--force] [--json]    Reinstall the systemd instance unit template",
    "  restart <id> [--json]         Reload-or-restart one repo instance",
    "  status <id> [--json]          Show systemd state for one repo instance",
    "  logs <id> [--lines <count>] [--json]",
    "                                Show recent journal logs for one repo instance",
  ].join("\n");
}

function queueHelpText(): string {
  return [
    "Usage:",
    "  merge-steward queue <command> [options]",
    "",
    "Commands:",
    "  status --repo <id>                                 Show queue summary and entries",
    "  show --repo <id> (--entry <id> | --pr <num>)       Show one queue entry with events and incidents",
    "  watch --repo <id> [--pr <number>]                  Open the queue watch TUI",
    "  reconcile --repo <id> [--json]                     Ask the local service to reconcile immediately",
  ].join("\n");
}

function helpTextFor(topic: HelpTopic): string {
  switch (topic) {
    case "repos":
      return reposHelpText();
    case "service":
      return serviceHelpText();
    case "queue":
      return queueHelpText();
    default:
      return rootHelpText();
  }
}

function resolveConfigPath(flags: Map<string, string | boolean>): string | undefined {
  const explicit = flags.get("config");
  if (typeof explicit === "string") {
    return explicit;
  }
  const repoId = flags.get("repo");
  if (typeof repoId === "string") {
    return getRepoConfigPath(repoId);
  }
  return undefined;
}

async function defaultRunCommand(command: string, args: string[]): Promise<CommandResult> {
  const result = spawnSync(command, args, {
    encoding: "utf8",
  });
  if (result.error) {
    throw result.error;
  }
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function formatCommandFailure(result: CommandResult, fallback: string): string {
  return result.stderr.trim() || result.stdout.trim() || fallback;
}

function parseSystemctlShowOutput(raw: string): Record<string, string> {
  const properties: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    properties[trimmed.slice(0, separator)] = trimmed.slice(separator + 1);
  }
  return properties;
}

async function runSystemctl(runCommand: CommandRunner, args: string[]): Promise<{ ok: true; result: CommandResult } | { ok: false; error: string; result: CommandResult }> {
  const result = await runCommand("sudo", ["systemctl", ...args]);
  if (result.exitCode === 0) {
    return { ok: true, result };
  }
  return {
    ok: false,
    error: formatCommandFailure(result, `sudo systemctl ${args.join(" ")} exited with status ${result.exitCode}`),
    result,
  };
}

function resolveRepoId(parsed: ParsedArgs, positionalIndex = 2, helpTopic: HelpTopic = "root"): string {
  const positional = parsed.positionals[positionalIndex];
  if (positional) {
    return positional;
  }
  const flagged = parsed.flags.get("repo");
  if (typeof flagged === "string" && flagged.trim()) {
    return flagged.trim();
  }
  throw new UsageError("Repo id is required.", helpTopic);
}

function readHomeConfig(): { configPath: string; config: ReturnType<typeof parseHomeConfigObject> } {
  const configPath = getDefaultConfigPath();
  if (!existsSync(configPath)) {
    throw new UsageError(`merge-steward home is not initialized. Run \`merge-steward init <public-base-url>\` first so ${configPath} exists.`);
  }
  return {
    configPath,
    config: parseHomeConfigObject(readFileSync(configPath, "utf8"), configPath),
  };
}

function listRepoConfigs(): Array<{
  repoId: string;
  repoFullName: string;
  baseBranch: string;
  requiredChecks: string[];
  admissionLabel: string;
  port: number;
  configPath: string;
}> {
  const repoConfigDir = getDefaultRepoConfigDir();
  if (!existsSync(repoConfigDir)) {
    return [];
  }
  return readdirSync(repoConfigDir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const configPath = path.join(repoConfigDir, name);
      const config = parseConfig(readFileSync(configPath, "utf8"), { configPath });
      return {
        repoId: config.repoId,
        repoFullName: config.repoFullName,
        baseBranch: config.baseBranch,
        requiredChecks: config.requiredChecks,
        admissionLabel: config.admissionLabel,
        port: config.server.port,
        configPath,
      };
    });
}

function loadRepoConfigById(repoId: string): { configPath: string; config: StewardConfig } {
  const configPath = getRepoConfigPath(repoId);
  if (!existsSync(configPath)) {
    throw new UsageError(`Repo config not found: ${configPath}. Run \`merge-steward attach ${repoId} <owner/repo>\` first.`, "repos");
  }
  return {
    configPath,
    config: loadConfig(configPath),
  };
}

function buildWebhookUrl(config: StewardConfig): string | undefined {
  const homeConfigPath = getDefaultConfigPath();
  if (!existsSync(homeConfigPath)) {
    return undefined;
  }
  const homeConfig = parseHomeConfigObject(readFileSync(homeConfigPath, "utf8"), homeConfigPath);
  const publicBaseUrl = config.server.publicBaseUrl ?? homeConfig.server.public_base_url;
  return publicBaseUrl ? new URL(config.webhookPath, publicBaseUrl).toString() : undefined;
}

function buildWebhookPattern(publicBaseUrl: string): string {
  return `${publicBaseUrl.replace(/\/$/, "")}/webhooks/github/queue/<repo-id>`;
}

async function fetchLocalJson<T>(config: StewardConfig, relativePath: string, options?: { method?: string }): Promise<T> {
  const response = await fetch(
    `http://${config.server.bind}:${config.server.port}${relativePath}`,
    {
      method: options?.method ?? "GET",
      signal: AbortSignal.timeout(2000),
    },
  );
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${relativePath}`);
  }
  return await response.json() as T;
}

async function readQueueSnapshot(config: StewardConfig, eventLimit: number): Promise<{ source: "service" | "database"; snapshot: QueueWatchSnapshot }> {
  try {
    const query = new URLSearchParams({ eventLimit: String(eventLimit) });
    const snapshot = await fetchLocalJson<QueueWatchSnapshot>(config, `/queue/watch?${query.toString()}`);
    return { source: "service", snapshot };
  } catch {
    const store = new SqliteStore(config.database.path);
    try {
      const entries = store.listAll(config.repoId);
      return {
        source: "database",
        snapshot: {
          repoId: config.repoId,
          repoFullName: config.repoFullName,
          baseBranch: config.baseBranch,
          summary: buildSummary(entries),
          runtime: {
            tickInProgress: false,
            lastTickStartedAt: null,
            lastTickCompletedAt: null,
            lastTickOutcome: "idle",
            lastTickError: null,
          },
          entries,
          recentEvents: store.listRecentEvents(config.repoId, { limit: eventLimit }),
        },
      };
    } finally {
      store.close();
    }
  }
}

function findEntryForInspect(store: SqliteStore, repoId: string, options: { entryId?: string; prNumber?: number }): QueueEntry | undefined {
  if (options.entryId) {
    return store.getEntry(options.entryId);
  }
  if (options.prNumber !== undefined) {
    return store.listAll(repoId).find((entry) => entry.prNumber === options.prNumber);
  }
  return undefined;
}

function readQueueEntryDetail(config: StewardConfig, options: { entryId?: string; prNumber?: number; eventLimit: number }): QueueEntryDetail | undefined {
  const store = new SqliteStore(config.database.path);
  try {
    const entry = findEntryForInspect(store, config.repoId, options);
    if (!entry || entry.repoId !== config.repoId) {
      return undefined;
    }
    return {
      entry,
      events: store.listEvents(entry.id, { limit: options.eventLimit }),
      incidents: store.listIncidents(entry.id),
    };
  } finally {
    store.close();
  }
}

async function handleInit(parsed: ParsedArgs, stdout: Output, runCommand: CommandRunner): Promise<number> {
  const target = parsed.positionals[1];
  if (!target) {
    throw new UsageError("merge-steward init requires <public-base-url>.");
  }
  const publicBaseUrl = normalizePublicBaseUrl(target);
  const home = await initializeMergeStewardHome({
    publicBaseUrl,
    force: parsed.flags.get("force") === true,
  });
  const unit = await installServiceUnit({ force: parsed.flags.get("force") === true });
  const reloadState = await runSystemctl(runCommand, ["daemon-reload"]);

  const payload = {
    ...home,
    unitTemplatePath: unit.unitTemplatePath,
    serviceUnitStatus: unit.status,
    webhookBaseUrl: buildWebhookPattern(publicBaseUrl),
    serviceReloaded: reloadState.ok,
    ...(reloadState.ok ? {} : { serviceReloadError: reloadState.error }),
  };

  if (parsed.flags.get("json") === true) {
    writeOutput(stdout, formatJson(payload));
    return 0;
  }

  writeOutput(
    stdout,
    [
      `Config directory: ${home.configDir}`,
      `Runtime env: ${home.runtimeEnvPath} (${home.runtimeEnvStatus})`,
      `Service env: ${home.serviceEnvPath} (${home.serviceEnvStatus})`,
      `Home config: ${home.configPath} (${home.configStatus})`,
      `Repo configs: ${home.repoConfigDir}`,
      `State directory: ${home.stateDir}`,
      `Data directory: ${home.dataDir}`,
      `Systemd unit template: ${unit.unitTemplatePath} (${unit.status})`,
      "",
      "Public URLs:",
      `- Base URL: ${publicBaseUrl}`,
      `- Repo webhook pattern: ${buildWebhookPattern(publicBaseUrl)}`,
      "",
      reloadState.ok
        ? "systemd daemon-reload completed."
        : `systemd daemon-reload failed: ${reloadState.error}`,
      "",
      "Next steps:",
      `1. Put secrets into ${home.serviceEnvPath} for dev or systemd-creds for prod`,
      "2. Run `merge-steward attach <id> <owner/repo>`",
      "3. Point the repository webhook at the printed repo-specific URL",
      "4. Run `merge-steward doctor --repo <id>`",
      "5. Run `merge-steward service status <id>`",
    ].join("\n") + "\n",
  );
  return 0;
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
      writeOutput(stdout, "No attached repositories yet. Run `merge-steward attach <id> <owner/repo>`.\n");
      return 0;
    }
    writeOutput(
      stdout,
      repos
        .map((repo) => `${repo.repoId}  ${repo.repoFullName}  base=${repo.baseBranch}  port=${repo.port}`)
        .join("\n") + "\n",
    );
    return 0;
  }

  const { configPath, config } = loadRepoConfigById(repoId);
  const payload = {
    repoId: config.repoId,
    repoFullName: config.repoFullName,
    baseBranch: config.baseBranch,
    requiredChecks: config.requiredChecks,
    admissionLabel: config.admissionLabel,
    configPath,
    clonePath: config.clonePath,
    databasePath: config.database.path,
    bind: config.server.bind,
    port: config.server.port,
    webhookPath: config.webhookPath,
    ...(buildWebhookUrl(config) ? { webhookUrl: buildWebhookUrl(config) } : {}),
  };
  if (parsed.flags.get("json") === true) {
    writeOutput(stdout, formatJson(payload));
    return 0;
  }
  writeOutput(
    stdout,
    [
      `Repo: ${config.repoId}`,
      `GitHub repo: ${config.repoFullName}`,
      `Config path: ${configPath}`,
      `Base branch: ${config.baseBranch}`,
      `Required checks: ${config.requiredChecks.length > 0 ? config.requiredChecks.join(", ") : "(any green check)"}`,
      `Admission label: ${config.admissionLabel}`,
      `Local address: http://${config.server.bind}:${config.server.port}`,
      `Webhook path: ${config.webhookPath}`,
      buildWebhookUrl(config) ? `Webhook URL: ${buildWebhookUrl(config)}` : undefined,
    ]
      .filter(Boolean)
      .join("\n") + "\n",
  );
  return 0;
}

async function handleAttach(parsed: ParsedArgs, stdout: Output, runCommand: CommandRunner): Promise<number> {
  const repoId = parsed.positionals[1];
  const repoFullName = parsed.positionals[2];
  if (!repoId || !repoFullName) {
    throw new UsageError("merge-steward attach requires <id> and <owner/repo>.", "repos");
  }

  const baseBranch = typeof parsed.flags.get("base-branch") === "string" ? String(parsed.flags.get("base-branch")) : undefined;
  const admissionLabel = typeof parsed.flags.get("label") === "string" ? String(parsed.flags.get("label")) : undefined;

  const result = await upsertRepoConfig({
    id: repoId,
    repoFullName,
    ...(baseBranch ? { baseBranch } : {}),
    ...(parseCsvFlag(parsed.flags.get("required-check")).length > 0
      ? { requiredChecks: parseCsvFlag(parsed.flags.get("required-check")) }
      : {}),
    ...(admissionLabel ? { admissionLabel } : {}),
  });

  const unitInstall = await installServiceUnit();
  const daemonReload = await runSystemctl(runCommand, ["daemon-reload"]);
  const enableState = await runSystemctl(runCommand, ["enable", `merge-steward@${repoId}.service`]);
  const restartState = await runSystemctl(runCommand, ["reload-or-restart", `merge-steward@${repoId}.service`]);
  const { config: homeConfig } = readHomeConfig();
  const publicBaseUrl = homeConfig.server.public_base_url;
  const webhookUrl = publicBaseUrl ? new URL(result.repo.webhookPath, publicBaseUrl).toString() : undefined;

  const payload = {
    ...result,
    unitTemplatePath: unitInstall.unitTemplatePath,
    daemonReloaded: daemonReload.ok,
    serviceEnabled: enableState.ok,
    serviceRestarted: restartState.ok,
    ...(webhookUrl ? { webhookUrl } : {}),
    errors: [
      ...(daemonReload.ok ? [] : [daemonReload.error]),
      ...(enableState.ok ? [] : [enableState.error]),
      ...(restartState.ok ? [] : [restartState.error]),
    ],
  };

  if (parsed.flags.get("json") === true) {
    writeOutput(stdout, formatJson(payload));
    return daemonReload.ok && enableState.ok && restartState.ok ? 0 : 1;
  }

  writeOutput(
    stdout,
    [
      `Repo config: ${result.configPath}`,
      `${result.status === "created" ? "Attached" : result.status === "updated" ? "Updated" : "Verified"} repo ${result.repo.id} for ${result.repo.repoFullName}`,
      `Base branch: ${result.repo.baseBranch}`,
      `Admission label: ${result.repo.admissionLabel}`,
      `Required checks: ${result.repo.requiredChecks.length > 0 ? result.repo.requiredChecks.join(", ") : "(any green check)"}`,
      `Local port: ${result.repo.port}`,
      webhookUrl ? `Webhook URL: ${webhookUrl}` : "Webhook URL: set MERGE_STEWARD_PUBLIC_BASE_URL in runtime.env or merge-steward.json to print this",
      daemonReload.ok ? "systemd daemon-reload completed." : `systemd daemon-reload failed: ${daemonReload.error}`,
      enableState.ok ? `Enabled merge-steward@${repoId}.service` : `Enable failed: ${enableState.error}`,
      restartState.ok ? `Restarted merge-steward@${repoId}.service` : `Restart failed: ${restartState.error}`,
      "Next: merge-steward service status " + repoId,
    ].join("\n") + "\n",
  );
  return daemonReload.ok && enableState.ok && restartState.ok ? 0 : 1;
}

interface DoctorCheck {
  status: "pass" | "warn" | "fail";
  scope: string;
  message: string;
}

function checkPath(scope: string, targetPath: string, writable = false): DoctorCheck {
  if (!existsSync(targetPath)) {
    return { status: "fail", scope, message: `Missing path: ${targetPath}` };
  }
  try {
    const stats = statSync(targetPath);
    if (!stats.isDirectory() && !stats.isFile()) {
      return { status: "fail", scope, message: `Unexpected path type: ${targetPath}` };
    }
    if (writable) {
      accessSync(stats.isDirectory() ? targetPath : path.dirname(targetPath), constants.W_OK);
    }
    return { status: "pass", scope, message: writable ? `${targetPath} is writable` : `${targetPath} exists` };
  } catch (error) {
    return {
      status: "fail",
      scope,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function checkExecutable(scope: string, command: string): Promise<DoctorCheck> {
  const result = spawnSync(command, ["--version"], { stdio: "ignore" });
  if (result.status === 0) {
    return { status: "pass", scope, message: `${command} is available` };
  }
  return { status: "fail", scope, message: `${command} is not available in PATH` };
}

async function handleDoctor(parsed: ParsedArgs, stdout: Output): Promise<number> {
  const repoId = typeof parsed.flags.get("repo") === "string" ? String(parsed.flags.get("repo")) : undefined;
  const checks: DoctorCheck[] = [];
  const env = getHomeEnv();

  checks.push(checkPath("home-config", getDefaultConfigPath()));
  checks.push(checkPath("runtime-env", getDefaultRuntimeEnvPath()));
  checks.push(checkPath("service-env", getDefaultServiceEnvPath()));
  checks.push(checkPath("repo-config-dir", getDefaultRepoConfigDir(), true));
  checks.push(checkPath("state-dir", getDefaultStateDir(), true));
  checks.push(checkPath("systemd-unit", getSystemdUnitTemplatePath()));
  checks.push(await checkExecutable("git", "git"));
  checks.push(await checkExecutable("gh", "gh"));

  const webhookSecret = resolveSecretWithSource("merge-steward-webhook-secret", "MERGE_STEWARD_WEBHOOK_SECRET", env);
  checks.push({
    status: webhookSecret.value ? "pass" : "warn",
    scope: "webhook-secret",
    message: webhookSecret.value
      ? `Webhook secret resolved from ${webhookSecret.source}`
      : "Webhook secret is missing; signed webhook verification will be disabled",
  });

  const githubToken = resolveSecretWithSource("merge-steward-github-token", "MERGE_STEWARD_GITHUB_TOKEN", env);
  checks.push({
    status: githubToken.value ? "pass" : "fail",
    scope: "github-token",
    message: githubToken.value
      ? `GitHub token resolved from ${githubToken.source}`
      : "GitHub token is missing; steward cannot call gh for merge/check operations",
  });

  let repoConfigPath: string | undefined;
  if (repoId) {
    repoConfigPath = getRepoConfigPath(repoId);
    if (!existsSync(repoConfigPath)) {
      checks.push({ status: "fail", scope: `repo:${repoId}`, message: `Repo config not found: ${repoConfigPath}` });
    } else {
      try {
        const config = loadConfig(repoConfigPath);
        mkdirSync(path.dirname(config.database.path), { recursive: true });
        mkdirSync(path.dirname(config.clonePath), { recursive: true });
        checks.push({ status: "pass", scope: `repo:${repoId}`, message: `Repo config is valid for ${config.repoFullName}` });
        checks.push(checkPath(`repo:${repoId}:database-dir`, path.dirname(config.database.path), true));
        checks.push(checkPath(`repo:${repoId}:clone-parent`, path.dirname(config.clonePath), true));
        if (githubToken.value) {
          try {
            const auth = await exec("gh", ["api", "user", "--jq", ".login"], {
              allowNonZero: true,
              env: {
                ...process.env,
                ...Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined)),
              },
            });
            if (auth.exitCode === 0 && auth.stdout.trim()) {
              checks.push({ status: "pass", scope: "github-auth", message: `gh authenticated as ${auth.stdout.trim()}` });
            } else {
              checks.push({ status: "warn", scope: "github-auth", message: "gh did not confirm the current auth identity" });
            }
          } catch (error) {
            checks.push({
              status: "warn",
              scope: "github-auth",
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
      } catch (error) {
        checks.push({
          status: "fail",
          scope: `repo:${repoId}`,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const ok = checks.every((check) => check.status !== "fail");
  if (parsed.flags.get("json") === true) {
    writeOutput(stdout, formatJson({ ok, checks, ...(repoConfigPath ? { repoConfigPath } : {}) }));
    return ok ? 0 : 1;
  }

  writeOutput(stdout, `${checks.map((check) => `[${check.status}] ${check.scope}: ${check.message}`).join("\n")}\n`);
  return ok ? 0 : 1;
}

async function handleService(parsed: ParsedArgs, stdout: Output, runCommand: CommandRunner): Promise<number> {
  const subcommand = parsed.positionals[1];
  if (!subcommand) {
    throw new UsageError("merge-steward service requires a subcommand.", "service");
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
        `Systemd unit template: ${result.unitTemplatePath} (${result.status})`,
        reload.ok ? "systemd daemon-reload completed." : `systemd daemon-reload failed: ${reload.error}`,
      ].join("\n") + "\n",
    );
    return reload.ok ? 0 : 1;
  }

  const repoId = parsed.positionals[2];
  if (!repoId) {
    throw new UsageError(`merge-steward service ${subcommand} requires <id>.`, "service");
  }

  if (subcommand === "restart") {
    const daemonReload = await runSystemctl(runCommand, ["daemon-reload"]);
    const restart = await runSystemctl(runCommand, ["reload-or-restart", `merge-steward@${repoId}.service`]);
    if (parsed.flags.get("json") === true) {
      writeOutput(stdout, formatJson({
        repoId,
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
        restart.ok ? `Restarted merge-steward@${repoId}.service` : `Restart failed: ${restart.error}`,
      ].join("\n") + "\n",
    );
    return daemonReload.ok && restart.ok ? 0 : 1;
  }

  if (subcommand === "status") {
    const status = await runSystemctl(runCommand, [
      "show",
      `merge-steward@${repoId}.service`,
      "--property=Id,LoadState,UnitFileState,ActiveState,SubState,FragmentPath,ExecMainPID",
    ]);
    if (!status.ok) {
      throw new Error(status.error);
    }
    const properties = parseSystemctlShowOutput(status.result.stdout);
    const payload = {
      repoId,
      unit: `merge-steward@${repoId}.service`,
      systemd: properties,
    };
    if (parsed.flags.get("json") === true) {
      writeOutput(stdout, formatJson(payload));
      return 0;
    }
    writeOutput(
      stdout,
      [
        `Repo instance: ${repoId}`,
        `Unit: ${properties.Id ?? `merge-steward@${repoId}.service`}`,
        `Load state: ${properties.LoadState ?? "unknown"}`,
        `Enabled: ${properties.UnitFileState ?? "unknown"}`,
        `Active: ${properties.ActiveState ?? "unknown"}${properties.SubState ? ` (${properties.SubState})` : ""}`,
        `Unit path: ${properties.FragmentPath || getSystemdUnitTemplatePath()}`,
        properties.ExecMainPID ? `Main PID: ${properties.ExecMainPID}` : undefined,
      ]
        .filter(Boolean)
        .join("\n") + "\n",
    );
    return 0;
  }

  if (subcommand === "logs") {
    const lines = parseIntegerFlag(parsed.flags.get("lines"), "--lines") ?? 50;
    const result = await runCommand("sudo", [
      "journalctl",
      "-u",
      `merge-steward@${repoId}.service`,
      "-n",
      String(lines),
      "--no-pager",
      "-o",
      "short-iso",
    ]);
    if (result.exitCode !== 0) {
      throw new Error(formatCommandFailure(result, `Unable to read logs for merge-steward@${repoId}.service.`));
    }
    const logs = result.stdout.split(/\r?\n/).filter(Boolean);
    if (parsed.flags.get("json") === true) {
      writeOutput(stdout, formatJson({
        repoId,
        unit: `merge-steward@${repoId}.service`,
        lines,
        logs,
      }));
      return 0;
    }
    writeOutput(stdout, `${result.stdout}${result.stdout.endsWith("\n") || result.stdout.length === 0 ? "" : "\n"}`);
    return 0;
  }

  throw new UsageError(`Unknown service command: ${subcommand}`, "service");
}

async function handleQueue(parsed: ParsedArgs, stdout: Output): Promise<number> {
  const subcommand = parsed.positionals[1];
  if (!subcommand) {
    throw new UsageError("merge-steward queue requires a subcommand.", "queue");
  }

  if (subcommand === "watch") {
    const repoId = resolveRepoId(parsed, 2, "queue");
    const { startWatch } = await import("./watch/index.tsx");
    await startWatch(getRepoConfigPath(repoId), parseIntegerFlag(parsed.flags.get("pr"), "--pr"));
    return 0;
  }

  const repoId = resolveRepoId(parsed, 2, "queue");
  const { config } = loadRepoConfigById(repoId);

  if (subcommand === "status") {
    const eventLimit = parseIntegerFlag(parsed.flags.get("events"), "--events") ?? 20;
    const { source, snapshot } = await readQueueSnapshot(config, eventLimit);
    const payload = { source, ...snapshot };
    if (parsed.flags.get("json") === true) {
      writeOutput(stdout, formatJson(payload));
      return 0;
    }
    writeOutput(
      stdout,
      [
        `Repo: ${snapshot.repoId} (${snapshot.repoFullName})`,
        `Source: ${source}`,
        `Base branch: ${snapshot.baseBranch}`,
        `Active entries: ${snapshot.summary.active}`,
        `Queued: ${snapshot.summary.queued}  preparing: ${snapshot.summary.preparingHead}  validating: ${snapshot.summary.validating}  merging: ${snapshot.summary.merging}`,
        `Merged: ${snapshot.summary.merged}  evicted: ${snapshot.summary.evicted}  dequeued: ${snapshot.summary.dequeued}`,
        snapshot.summary.headPrNumber ? `Head PR: #${snapshot.summary.headPrNumber}` : "Head PR: none",
        "",
        "Entries:",
        ...(snapshot.entries.length > 0
          ? snapshot.entries.map((entry) => `- #${entry.prNumber} ${entry.status} pos=${entry.position} branch=${entry.branch}`)
          : ["- (none)"]),
      ].join("\n") + "\n",
    );
    return 0;
  }

  if (subcommand === "show") {
    const entryId = typeof parsed.flags.get("entry") === "string" ? String(parsed.flags.get("entry")) : undefined;
    const prNumber = parseIntegerFlag(parsed.flags.get("pr"), "--pr");
    if (!entryId && prNumber === undefined) {
      throw new UsageError("merge-steward queue show requires --entry <id> or --pr <number>.", "queue");
    }
    const detail = readQueueEntryDetail(config, {
      ...(entryId ? { entryId } : {}),
      ...(prNumber !== undefined ? { prNumber } : {}),
      eventLimit: parseIntegerFlag(parsed.flags.get("events"), "--events") ?? 100,
    });
    if (!detail) {
      throw new Error(`Queue entry not found for repo ${repoId}.`);
    }
    if (parsed.flags.get("json") === true) {
      writeOutput(stdout, formatJson({
        repoId,
        ...detail,
      }));
      return 0;
    }
    writeOutput(
      stdout,
      [
        `Repo: ${repoId}`,
        `Entry: ${detail.entry.id}`,
        `PR: #${detail.entry.prNumber}`,
        `Status: ${detail.entry.status}`,
        `Position: ${detail.entry.position}`,
        `Branch: ${detail.entry.branch}`,
        `Head SHA: ${detail.entry.headSha}`,
        detail.entry.baseSha ? `Base SHA: ${detail.entry.baseSha}` : undefined,
        detail.entry.issueKey ? `Issue: ${detail.entry.issueKey}` : undefined,
        "",
        "Events:",
        ...(detail.events.length > 0
          ? detail.events.map((event) => `- ${event.at} ${event.fromStatus ?? "(start)"} -> ${event.toStatus}${event.detail ? ` (${event.detail})` : ""}`)
          : ["- (none)"]),
        "",
        "Incidents:",
        ...(detail.incidents.length > 0
          ? detail.incidents.map((incident) => `- ${incident.at} ${incident.failureClass} (${incident.outcome})`)
          : ["- (none)"]),
      ]
        .filter(Boolean)
        .join("\n") + "\n",
    );
    return 0;
  }

  if (subcommand === "reconcile") {
    try {
      const result = await fetchLocalJson<{ ok: boolean; started: boolean; runtime: QueueWatchSnapshot["runtime"] }>(
        config,
        "/queue/reconcile",
        { method: "POST" },
      );
      if (parsed.flags.get("json") === true) {
        writeOutput(stdout, formatJson({ repoId, ...result }));
      } else {
        writeOutput(
          stdout,
          [
            `Repo: ${repoId}`,
            result.started ? "Reconcile started." : "Reconcile request accepted; a tick was already in progress.",
            `Last outcome: ${result.runtime.lastTickOutcome}`,
          ].join("\n") + "\n",
        );
      }
      return 0;
    } catch (error) {
      throw new Error(`Unable to reach the local merge-steward service for ${repoId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new UsageError(`Unknown queue command: ${subcommand}`, "queue");
}

export async function runCli(argv: string[], options?: RunCliOptions): Promise<number> {
  const stdout = options?.stdout ?? process.stdout;
  const stderr = options?.stderr ?? process.stderr;
  const runCommand = options?.runCommand ?? defaultRunCommand;

  try {
    const parsed = parseArgs(argv);
    validateFlags(parsed);
    const command = parsed.positionals[0] ?? "help";

    if (hasHelpFlag(parsed) || command === "help") {
      const topic = command === "help"
        ? ((parsed.positionals[1] as "root" | "attach" | "repos" | "service" | "queue" | undefined) ?? "root")
        : (command === "attach" || command === "repos"
            ? "repos"
            : command === "service" || command === "queue"
              ? command
              : "root");
      if (!["root", "attach", "repos", "service", "queue"].includes(topic)) {
        throw new UsageError(`Unknown help topic: ${String(topic)}`);
      }
      writeOutput(stdout, `${helpTextFor(topic === "attach" ? "repos" : topic)}\n`);
      return 0;
    }

    switch (command) {
      case "serve":
        await (await import("./server.ts")).startServer(resolveConfigPath(parsed.flags));
        return 0;
      case "init":
        return await handleInit(parsed, stdout, runCommand);
      case "attach":
        return await handleAttach(parsed, stdout, runCommand);
      case "repos":
        return await handleRepos(parsed, stdout);
      case "doctor":
        return await handleDoctor(parsed, stdout);
      case "service":
        return await handleService(parsed, stdout, runCommand);
      case "queue":
        return await handleQueue(parsed, stdout);
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
