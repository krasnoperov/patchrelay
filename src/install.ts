import crypto from "node:crypto";
import { basename, dirname } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import YAML from "yaml";
import {
  getDefaultConfigPath,
  getDefaultDatabasePath,
  getDefaultEnvPath,
  getDefaultLogPath,
  getDefaultWebhookArchiveDir,
  getPatchRelayConfigDir,
  getPatchRelayDataDir,
  getPatchRelayStateDir,
  getSystemdUserUnitPath,
  readBundledAsset,
} from "./runtime-paths.ts";
import { loadConfig } from "./config.ts";
import { ensureAbsolutePath } from "./utils.ts";

function renderTemplate(template: string, replacements?: { publicBaseUrl?: string }): string {
  const home = homedir();
  const user = basename(home);
  const rendered = template
    .replaceAll("${PATCHRELAY_CONFIG:-/home/your-user/.config/patchrelay/patchrelay.yaml}", getDefaultConfigPath())
    .replaceAll("${PATCHRELAY_DB_PATH:-/home/your-user/.local/state/patchrelay/patchrelay.sqlite}", getDefaultDatabasePath())
    .replaceAll("${PATCHRELAY_LOG_FILE:-/home/your-user/.local/state/patchrelay/patchrelay.log}", getDefaultLogPath())
    .replaceAll("/home/your-user/.config/patchrelay/.env", getDefaultEnvPath())
    .replaceAll("/home/your-user/.config/patchrelay/patchrelay.yaml", getDefaultConfigPath())
    .replaceAll("/home/your-user/.config/patchrelay", getPatchRelayConfigDir())
    .replaceAll("/home/your-user/.local/state/patchrelay/webhooks", getDefaultWebhookArchiveDir())
    .replaceAll("/home/your-user/.local/state/patchrelay", getPatchRelayStateDir())
    .replaceAll("/home/your-user/.local/share/patchrelay", getPatchRelayDataDir())
    .replaceAll("/home/your-user", home)
    .replaceAll("your-user", user);

  if (replacements?.publicBaseUrl) {
    return rendered.replaceAll("https://patchrelay.example.com", replacements.publicBaseUrl);
  }

  return rendered;
}

function generateSecret(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("hex");
}

function renderEnvTemplate(template: string): string {
  return template
    .replace(
      "LINEAR_WEBHOOK_SECRET=replace-with-linear-webhook-secret",
      `LINEAR_WEBHOOK_SECRET=${generateSecret()}`,
    )
    .replace(
      "PATCHRELAY_TOKEN_ENCRYPTION_KEY=replace-with-long-random-secret",
      `PATCHRELAY_TOKEN_ENCRYPTION_KEY=${generateSecret()}`,
    );
}

async function writeTemplateFile(targetPath: string, content: string, force: boolean): Promise<"created" | "skipped"> {
  if (!force && existsSync(targetPath)) {
    return "skipped";
  }

  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, content, "utf8");
  return "created";
}

async function applyPublicBaseUrlToConfig(
  configPath: string,
  publicBaseUrl?: string,
): Promise<"created" | "updated" | "skipped"> {
  if (!publicBaseUrl || !existsSync(configPath)) {
    return "skipped";
  }

  const original = await readFile(configPath, "utf8");
  const document = YAML.parseDocument(original);
  const serverNode = document.get("server", true);
  if (YAML.isMap(serverNode)) {
    serverNode.set("public_base_url", publicBaseUrl);
  } else {
    document.set("server", document.createNode({ public_base_url: publicBaseUrl }));
  }

  const next = document.toString();
  if (next === original) {
    return "skipped";
  }

  await writeFile(configPath, next, "utf8");
  return "updated";
}

export async function initializePatchRelayHome(options?: { force?: boolean; publicBaseUrl?: string }): Promise<{
  configDir: string;
  envPath: string;
  configPath: string;
  stateDir: string;
  dataDir: string;
  envStatus: "created" | "skipped";
  configStatus: "created" | "updated" | "skipped";
  publicBaseUrl?: string;
  webhookUrl?: string;
  oauthCallbackUrl?: string;
}> {
  const force = options?.force ?? false;
  const publicBaseUrl = options?.publicBaseUrl;
  const configDir = getPatchRelayConfigDir();
  const envPath = getDefaultEnvPath();
  const configPath = getDefaultConfigPath();
  const stateDir = getPatchRelayStateDir();
  const dataDir = getPatchRelayDataDir();

  await mkdir(configDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });

  const envTemplate = renderEnvTemplate(readBundledAsset(".env.example"));
  const configTemplate = renderTemplate(
    readBundledAsset("config/patchrelay.example.yaml"),
    publicBaseUrl ? { publicBaseUrl } : undefined,
  );

  const envStatus = await writeTemplateFile(envPath, envTemplate, force);
  const initialConfigStatus = await writeTemplateFile(configPath, configTemplate, force);
  const configStatus =
    initialConfigStatus === "created" ? initialConfigStatus : await applyPublicBaseUrlToConfig(configPath, publicBaseUrl);

  return {
    configDir,
    envPath,
    configPath,
    stateDir,
    dataDir,
    envStatus,
    configStatus,
    ...(publicBaseUrl
      ? {
          publicBaseUrl,
          webhookUrl: new URL("/webhooks/linear", publicBaseUrl).toString(),
          oauthCallbackUrl: new URL("/oauth/linear/callback", publicBaseUrl).toString(),
        }
      : {}),
  };
}

export async function installUserServiceUnit(options?: { force?: boolean }): Promise<{
  unitPath: string;
  envPath: string;
  configPath: string;
  status: "created" | "skipped";
}> {
  const force = options?.force ?? false;
  const unitPath = getSystemdUserUnitPath();
  const status = await writeTemplateFile(unitPath, renderTemplate(readBundledAsset("infra/patchrelay.service")), force);
  return {
    unitPath,
    envPath: getDefaultEnvPath(),
    configPath: getDefaultConfigPath(),
    status,
  };
}

export async function addProjectToConfig(options: {
  id: string;
  repoPath: string;
  issueKeyPrefixes?: string[];
  linearTeamIds?: string[];
  configPath?: string;
}): Promise<{
  configPath: string;
  project: {
    id: string;
    repoPath: string;
    issueKeyPrefixes: string[];
    linearTeamIds: string[];
  };
}> {
  const configPath = options.configPath ?? getDefaultConfigPath();
  if (!existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}. Run "patchrelay init <public-base-url>" first.`);
  }

  const projectId = options.id.trim();
  if (!projectId) {
    throw new Error("Project id is required.");
  }

  const repoPath = ensureAbsolutePath(options.repoPath);
  const issueKeyPrefixes = [...new Set((options.issueKeyPrefixes ?? []).map((value) => value.trim()).filter(Boolean))];
  const linearTeamIds = [...new Set((options.linearTeamIds ?? []).map((value) => value.trim()).filter(Boolean))];

  const original = await readFile(configPath, "utf8");
  const parsed = (YAML.parse(original) ?? {}) as { projects?: Array<Record<string, unknown>> };
  const existingProjects = Array.isArray(parsed.projects) ? parsed.projects : [];

  if (existingProjects.some((project) => String(project.id ?? "") === projectId)) {
    throw new Error(`Project already exists: ${projectId}`);
  }

  if (existingProjects.length > 0 && issueKeyPrefixes.length === 0 && linearTeamIds.length === 0) {
    throw new Error("Adding a second project requires routing. Use --issue-prefix or --team-id.");
  }

  if (existingProjects.length > 0) {
    const unscoped = existingProjects.find((project) => {
      const prefixes = Array.isArray(project.issue_key_prefixes) ? project.issue_key_prefixes : [];
      const teamIds = Array.isArray(project.linear_team_ids) ? project.linear_team_ids : [];
      const labels = Array.isArray(project.allow_labels) ? project.allow_labels : [];
      return prefixes.length === 0 && teamIds.length === 0 && labels.length === 0;
    });
    if (unscoped) {
      throw new Error(
        `Existing project ${String(unscoped.id ?? "unknown")} has no routing configured. Add routing before configuring multiple projects.`,
      );
    }
  }

  for (const prefix of issueKeyPrefixes) {
    const owner = existingProjects.find((project) =>
      Array.isArray(project.issue_key_prefixes) && project.issue_key_prefixes.map(String).includes(prefix),
    );
    if (owner) {
      throw new Error(`Issue key prefix "${prefix}" is already configured for project ${String(owner.id ?? "unknown")}`);
    }
  }

  for (const teamId of linearTeamIds) {
    const owner = existingProjects.find((project) =>
      Array.isArray(project.linear_team_ids) && project.linear_team_ids.map(String).includes(teamId),
    );
    if (owner) {
      throw new Error(`Linear team id "${teamId}" is already configured for project ${String(owner.id ?? "unknown")}`);
    }
  }

  const document = original.trim() ? YAML.parseDocument(original) : new YAML.Document({});
  if (!YAML.isMap(document.contents)) {
    throw new Error(`Config file must contain a YAML mapping at the top level: ${configPath}`);
  }

  let projectsNode = document.get("projects", true);
  if (!projectsNode) {
    projectsNode = document.createNode([]);
    document.set("projects", projectsNode);
  }
  if (!YAML.isSeq(projectsNode)) {
    throw new Error(`Config file field "projects" must be a YAML sequence: ${configPath}`);
  }

  const projectNode = document.createNode({
    id: projectId,
    repo_path: repoPath,
    ...(issueKeyPrefixes.length > 0 ? { issue_key_prefixes: issueKeyPrefixes } : {}),
    ...(linearTeamIds.length > 0 ? { linear_team_ids: linearTeamIds } : {}),
  });
  projectsNode.add(projectNode);

  const next = document.toString();
  await writeFile(configPath, next, "utf8");

  try {
    loadConfig(configPath, { requireLinearSecret: false, allowMissingSecrets: true });
  } catch (error) {
    await writeFile(configPath, original, "utf8");
    throw error;
  }

  return {
    configPath,
    project: {
      id: projectId,
      repoPath,
      issueKeyPrefixes,
      linearTeamIds,
    },
  };
}
