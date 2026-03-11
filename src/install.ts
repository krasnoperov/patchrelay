import crypto from "node:crypto";
import { basename, dirname } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import YAML from "yaml";
import {
  getDefaultConfigPath,
  getDefaultDatabasePath,
  getDefaultRuntimeEnvPath,
  getDefaultServiceEnvPath,
  getDefaultLogPath,
  getDefaultWebhookArchiveDir,
  getPatchRelayConfigDir,
  getPatchRelayDataDir,
  getPatchRelayStateDir,
  getSystemdUserPathUnitPath,
  getSystemdUserReloadUnitPath,
  getSystemdUserUnitPath,
  readBundledAsset,
} from "./runtime-paths.ts";
import { loadConfig } from "./config.ts";
import { ensureAbsolutePath } from "./utils.ts";

function defaultProjectWorkflows(): Array<Record<string, string>> {
  return [
    {
      id: "development",
      when_state: "Start",
      active_state: "Implementing",
      workflow_file: "IMPLEMENTATION_WORKFLOW.md",
      fallback_state: "Human Needed",
    },
    {
      id: "review",
      when_state: "Review",
      active_state: "Reviewing",
      workflow_file: "REVIEW_WORKFLOW.md",
      fallback_state: "Human Needed",
    },
    {
      id: "deploy",
      when_state: "Deploy",
      active_state: "Deploying",
      workflow_file: "DEPLOY_WORKFLOW.md",
      fallback_state: "Human Needed",
    },
    {
      id: "cleanup",
      when_state: "Cleanup",
      active_state: "Cleaning Up",
      workflow_file: "CLEANUP_WORKFLOW.md",
      fallback_state: "Human Needed",
    },
  ];
}

function renderTemplate(template: string, replacements?: { publicBaseUrl?: string }): string {
  const home = homedir();
  const user = basename(home);
  const rendered = template
    .replaceAll("${PATCHRELAY_CONFIG:-/home/your-user/.config/patchrelay/patchrelay.yaml}", getDefaultConfigPath())
    .replaceAll("${PATCHRELAY_DB_PATH:-/home/your-user/.local/state/patchrelay/patchrelay.sqlite}", getDefaultDatabasePath())
    .replaceAll("${PATCHRELAY_LOG_FILE:-/home/your-user/.local/state/patchrelay/patchrelay.log}", getDefaultLogPath())
    .replaceAll("/home/your-user/.config/patchrelay/runtime.env", getDefaultRuntimeEnvPath())
    .replaceAll("/home/your-user/.config/patchrelay/service.env", getDefaultServiceEnvPath())
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

function renderServiceEnvTemplate(template: string): string {
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
  runtimeEnvPath: string;
  serviceEnvPath: string;
  configPath: string;
  stateDir: string;
  dataDir: string;
  runtimeEnvStatus: "created" | "skipped";
  serviceEnvStatus: "created" | "skipped";
  configStatus: "created" | "updated" | "skipped";
  publicBaseUrl?: string;
  webhookUrl?: string;
  oauthCallbackUrl?: string;
}> {
  const force = options?.force ?? false;
  const publicBaseUrl = options?.publicBaseUrl;
  const configDir = getPatchRelayConfigDir();
  const runtimeEnvPath = getDefaultRuntimeEnvPath();
  const serviceEnvPath = getDefaultServiceEnvPath();
  const configPath = getDefaultConfigPath();
  const stateDir = getPatchRelayStateDir();
  const dataDir = getPatchRelayDataDir();

  await mkdir(configDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });

  const runtimeEnvTemplate = renderTemplate(readBundledAsset("runtime.env.example"));
  const serviceEnvTemplate = renderServiceEnvTemplate(readBundledAsset("service.env.example"));
  const configTemplate = renderTemplate(
    readBundledAsset("config/patchrelay.example.yaml"),
    publicBaseUrl ? { publicBaseUrl } : undefined,
  );

  const runtimeEnvStatus = await writeTemplateFile(runtimeEnvPath, runtimeEnvTemplate, force);
  const serviceEnvStatus = await writeTemplateFile(serviceEnvPath, serviceEnvTemplate, force);
  const initialConfigStatus = await writeTemplateFile(configPath, configTemplate, force);
  const configStatus =
    initialConfigStatus === "created" ? initialConfigStatus : await applyPublicBaseUrlToConfig(configPath, publicBaseUrl);

  return {
    configDir,
    runtimeEnvPath,
    serviceEnvPath,
    configPath,
    stateDir,
    dataDir,
    runtimeEnvStatus,
    serviceEnvStatus,
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

export async function installUserServiceUnits(options?: { force?: boolean }): Promise<{
  unitPath: string;
  reloadUnitPath: string;
  pathUnitPath: string;
  runtimeEnvPath: string;
  serviceEnvPath: string;
  configPath: string;
  serviceStatus: "created" | "skipped";
  reloadStatus: "created" | "skipped";
  pathStatus: "created" | "skipped";
}> {
  const force = options?.force ?? false;
  const unitPath = getSystemdUserUnitPath();
  const reloadUnitPath = getSystemdUserReloadUnitPath();
  const pathUnitPath = getSystemdUserPathUnitPath();
  const serviceStatus = await writeTemplateFile(unitPath, renderTemplate(readBundledAsset("infra/patchrelay.service")), force);
  const reloadStatus = await writeTemplateFile(
    reloadUnitPath,
    renderTemplate(readBundledAsset("infra/patchrelay-reload.service")),
    force,
  );
  const pathStatus = await writeTemplateFile(pathUnitPath, renderTemplate(readBundledAsset("infra/patchrelay.path")), force);
  return {
    unitPath,
    reloadUnitPath,
    pathUnitPath,
    runtimeEnvPath: getDefaultRuntimeEnvPath(),
    serviceEnvPath: getDefaultServiceEnvPath(),
    configPath: getDefaultConfigPath(),
    serviceStatus,
    reloadStatus,
    pathStatus,
  };
}

export async function upsertProjectInConfig(options: {
  id: string;
  repoPath: string;
  issueKeyPrefixes?: string[];
  linearTeamIds?: string[];
  configPath?: string;
}): Promise<{
  configPath: string;
  status: "created" | "updated" | "unchanged";
  project: {
    id: string;
    repoPath: string;
    issueKeyPrefixes: string[];
    linearTeamIds: string[];
  };
}> {
  const configPath = options.configPath ?? getDefaultConfigPath();
  if (!existsSync(configPath)) {
    throw new Error(
      `Config file not found: ${configPath}. Run "patchrelay init <public-base-url>" first so PatchRelay knows the public HTTPS origin for Linear.`,
    );
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
  const existingIndex = existingProjects.findIndex((project) => String(project.id ?? "") === projectId);
  const existingProject = existingIndex >= 0 ? existingProjects[existingIndex] : undefined;

  const nextProject: Record<string, unknown> = {
    ...(existingProject ?? {}),
    id: projectId,
    repo_path: repoPath,
    workflows:
      Array.isArray(existingProject?.workflows) && existingProject.workflows.length > 0
        ? existingProject.workflows
        : defaultProjectWorkflows(),
  };
  if (issueKeyPrefixes.length > 0) {
    nextProject.issue_key_prefixes = issueKeyPrefixes;
  } else {
    delete nextProject.issue_key_prefixes;
  }
  if (linearTeamIds.length > 0) {
    nextProject.linear_team_ids = linearTeamIds;
  } else {
    delete nextProject.linear_team_ids;
  }

  if (existingProjects.length - (existingProject ? 1 : 0) > 0 && issueKeyPrefixes.length === 0 && linearTeamIds.length === 0) {
    throw new Error("Adding or updating a project in a multi-project config requires routing. Use --issue-prefix or --team-id.");
  }

  if (existingProjects.length - (existingProject ? 1 : 0) > 0) {
    const unscoped = existingProjects.find((project, index) => {
      if (index === existingIndex) {
        return false;
      }
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
    const owner = existingProjects.find((project, index) =>
      index !== existingIndex &&
      Array.isArray(project.issue_key_prefixes) &&
      project.issue_key_prefixes.map(String).includes(prefix),
    );
    if (owner) {
      throw new Error(`Issue key prefix "${prefix}" is already configured for project ${String(owner.id ?? "unknown")}`);
    }
  }

  for (const teamId of linearTeamIds) {
    const owner = existingProjects.find((project, index) =>
      index !== existingIndex &&
      Array.isArray(project.linear_team_ids) &&
      project.linear_team_ids.map(String).includes(teamId),
    );
    if (owner) {
      throw new Error(`Linear team id "${teamId}" is already configured for project ${String(owner.id ?? "unknown")}`);
    }
  }

  const normalizedExistingProject =
    existingProject &&
    JSON.stringify({
      id: String(existingProject.id ?? ""),
      repo_path: String(existingProject.repo_path ?? ""),
      issue_key_prefixes: Array.isArray(existingProject.issue_key_prefixes)
        ? existingProject.issue_key_prefixes.map(String)
        : [],
      linear_team_ids: Array.isArray(existingProject.linear_team_ids) ? existingProject.linear_team_ids.map(String) : [],
    });
  const normalizedNextProject = JSON.stringify({
    id: String(nextProject.id ?? ""),
    repo_path: String(nextProject.repo_path ?? ""),
    issue_key_prefixes: issueKeyPrefixes,
    linear_team_ids: linearTeamIds,
  });
  const status: "created" | "updated" | "unchanged" =
    existingProject === undefined ? "created" : normalizedExistingProject === normalizedNextProject ? "unchanged" : "updated";

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

  if (status !== "unchanged") {
    const nextProjects = [...existingProjects];
    if (existingIndex >= 0) {
      nextProjects[existingIndex] = nextProject;
    } else {
      nextProjects.push(nextProject);
    }
    document.set("projects", document.createNode(nextProjects));

    const next = document.toString();
    await writeFile(configPath, next, "utf8");
  }

  try {
    loadConfig(configPath, { profile: "write_config" });
  } catch (error) {
    if (status !== "unchanged") {
      await writeFile(configPath, original, "utf8");
    }
    throw error;
  }

  return {
    configPath,
    status,
    project: {
      id: projectId,
      repoPath,
      issueKeyPrefixes,
      linearTeamIds,
    },
  };
}
