import { basename, dirname } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { DEFAULT_MERGE_QUEUE_CHECK_NAME, parseConfig, type StewardConfig } from "./config.ts";
import { getBuiltCliEntryPath, getDefaultConfigPath, getDefaultRepoConfigDir, getDefaultRuntimeEnvPath, getDefaultServiceEnvPath, getDefaultStateDir, getMergeStewardPathLayout, getRepoConfigPath, getSystemdUnitPath, readBundledAsset } from "./runtime-paths.ts";
import { parseHomeConfigObject, stringifyJson, type StewardHomeConfig } from "./steward-home.ts";

function renderTemplate(template: string, replacements?: { publicBaseUrl?: string }): string {
  const home = homedir();
  const user = basename(home);
  const layout = getMergeStewardPathLayout();
  let rendered = template
    .replaceAll("/home/your-user", home)
    .replaceAll("your-user", user)
    .replaceAll("/etc/systemd/system/merge-steward.service", layout.systemdUnitPath)
    .replaceAll("/home/your-user/.config/merge-steward/runtime.env", layout.runtimeEnvPath)
    .replaceAll("/home/your-user/.config/merge-steward/service.env", layout.serviceEnvPath)
    .replaceAll("/home/your-user/.config/merge-steward/merge-steward.json", layout.configPath)
    .replaceAll("/home/your-user/.config/merge-steward/repos", layout.repoConfigDir)
    .replaceAll("/home/your-user/.local/state/merge-steward", layout.stateDir)
    .replaceAll("/home/your-user/.local/share/merge-steward", layout.dataDir)
    .replaceAll("/usr/bin/env merge-steward", `${getBuiltCliEntryPath()}`);

  if (replacements?.publicBaseUrl) {
    rendered = rendered.replaceAll("https://queue.example.com", replacements.publicBaseUrl);
  }

  return rendered;
}

async function writeTemplateFile(
  targetPath: string,
  content: string,
  force: boolean,
  options?: { mode?: number },
): Promise<"created" | "skipped"> {
  if (!force && existsSync(targetPath)) {
    return "skipped";
  }

  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, content, "utf8");
  if (options?.mode !== undefined) {
    await writeFile(targetPath, content, { encoding: "utf8", mode: options.mode });
  }
  return "created";
}

async function applyPublicBaseUrlToConfig(configPath: string, publicBaseUrl: string): Promise<"created" | "updated" | "skipped"> {
  const raw = existsSync(configPath) ? await readFile(configPath, "utf8") : "{}\n";
  const document = parseHomeConfigObject(raw, configPath);
  const next: StewardHomeConfig = {
    ...document,
    server: {
      ...(document.server ?? {}),
      public_base_url: publicBaseUrl,
    },
  };
  const rendered = stringifyJson(next as unknown as Record<string, unknown>);
  if (!existsSync(configPath)) {
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, rendered, "utf8");
    return "created";
  }
  if (rendered === raw) {
    return "skipped";
  }
  await writeFile(configPath, rendered, "utf8");
  return "updated";
}

export async function initializeMergeStewardHome(options: { publicBaseUrl: string; force?: boolean }): Promise<{
  configDir: string;
  runtimeEnvPath: string;
  serviceEnvPath: string;
  configPath: string;
  repoConfigDir: string;
  stateDir: string;
  dataDir: string;
  runtimeEnvStatus: "created" | "skipped";
  serviceEnvStatus: "created" | "skipped";
  configStatus: "created" | "updated" | "skipped";
}> {
  const force = options.force ?? false;
  const layout = getMergeStewardPathLayout();
  await mkdir(layout.configDir, { recursive: true });
  await mkdir(layout.repoConfigDir, { recursive: true });
  await mkdir(layout.stateDir, { recursive: true });
  await mkdir(layout.dataDir, { recursive: true });

  const runtimeEnvStatus = await writeTemplateFile(
    layout.runtimeEnvPath,
    renderTemplate(readBundledAsset("runtime.env.example"), { publicBaseUrl: options.publicBaseUrl }),
    force,
  );
  const serviceEnvStatus = await writeTemplateFile(
    layout.serviceEnvPath,
    renderTemplate(readBundledAsset("service.env.example")),
    force,
    { mode: 0o600 },
  );
  const configStatus = await applyPublicBaseUrlToConfig(layout.configPath, options.publicBaseUrl);

  return {
    configDir: layout.configDir,
    runtimeEnvPath: layout.runtimeEnvPath,
    serviceEnvPath: layout.serviceEnvPath,
    configPath: layout.configPath,
    repoConfigDir: layout.repoConfigDir,
    stateDir: layout.stateDir,
    dataDir: layout.dataDir,
    runtimeEnvStatus,
    serviceEnvStatus,
    configStatus,
  };
}

export async function installServiceUnit(options?: { force?: boolean }): Promise<{
  unitPath: string;
  runtimeEnvPath: string;
  serviceEnvPath: string;
  configPath: string;
  status: "created" | "skipped";
}> {
  const force = options?.force ?? false;
  const unitPath = getSystemdUnitPath();
  const status = await writeTemplateFile(
    unitPath,
    renderTemplate(readBundledAsset("infra/merge-steward.service")),
    force,
  );
  return {
    unitPath,
    runtimeEnvPath: getDefaultRuntimeEnvPath(),
    serviceEnvPath: getDefaultServiceEnvPath(),
    configPath: getDefaultConfigPath(),
    status,
  };
}

function normalizeId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Repo id is required.");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(trimmed)) {
    throw new Error("Repo id may contain only letters, numbers, dots, underscores, and hyphens.");
  }
  return trimmed;
}

function parseRepoFullName(value: string): string {
  const trimmed = value.trim();
  if (!/^[^/\s]+\/[^/\s]+$/.test(trimmed)) {
    throw new Error(`GitHub repo must use owner/repo form. Received: ${value}`);
  }
  return trimmed;
}

function nextAvailablePort(existingPorts: number[], preferredBase: number): number {
  let port = preferredBase;
  const taken = new Set(existingPorts);
  while (taken.has(port)) {
    port += 1;
  }
  return port;
}

async function listRepoConfigPorts(repoConfigDir: string): Promise<number[]> {
  if (!existsSync(repoConfigDir)) {
    return [];
  }
  const names = await readdir(repoConfigDir);
  const ports: number[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = await readFile(`${repoConfigDir}/${name}`, "utf8");
      const config = parseConfig(raw, { configPath: `${repoConfigDir}/${name}` });
      ports.push(config.server.port);
    } catch {
      // Ignore broken files here; doctor will surface them later.
    }
  }
  return ports;
}

export async function upsertRepoConfig(options: {
  id: string;
  repoFullName: string;
  baseBranch?: string;
  requiredChecks?: string[];
  admissionLabel?: string;
  mergeQueueCheckName?: string;
}): Promise<{
  configPath: string;
  status: "created" | "updated" | "unchanged";
  repo: {
    id: string;
    repoFullName: string;
    baseBranch: string;
    requiredChecks: string[];
    admissionLabel: string;
    mergeQueueCheckName: string;
    port: number;
  };
}> {
  const layout = getMergeStewardPathLayout();
  if (!existsSync(layout.configPath)) {
    throw new Error(
      `merge-steward home is not initialized. Run \`merge-steward init <public-base-url>\` first so ${layout.configPath} exists.`,
    );
  }
  const homeRaw = await readFile(layout.configPath, "utf8");
  const homeConfig = parseHomeConfigObject(homeRaw, layout.configPath);
  const id = normalizeId(options.id);
  const repoFullName = parseRepoFullName(options.repoFullName);
  const configPath = getRepoConfigPath(id);
  const existingRaw = existsSync(configPath) ? await readFile(configPath, "utf8") : undefined;
  const existing: StewardConfig | undefined = existingRaw
    ? parseConfig(existingRaw, { configPath })
    : undefined;
  const requiredChecks = [...new Set((options.requiredChecks ?? existing?.requiredChecks ?? []).map((entry) => entry.trim()).filter(Boolean))];
  const baseBranch = options.baseBranch?.trim() || existing?.baseBranch || "main";
  const admissionLabel = options.admissionLabel?.trim() || existing?.admissionLabel || "queue";
  const mergeQueueCheckName = options.mergeQueueCheckName?.trim() || existing?.mergeQueueCheckName || DEFAULT_MERGE_QUEUE_CHECK_NAME;
  const existingPorts = await listRepoConfigPorts(layout.repoConfigDir);
  const port = existing?.server.port ?? nextAvailablePort(existingPorts, homeConfig.server?.port_base ?? 8790);

  const next = {
    repoId: id,
    repoFullName,
    baseBranch,
    clonePath: `${getDefaultStateDir()}/repos/${id}`,
    gitBin: existing?.gitBin ?? "git",
    maxRetries: existing?.maxRetries ?? 2,
    flakyRetries: existing?.flakyRetries ?? 1,
    speculativeDepth: existing?.speculativeDepth ?? 10,
    requiredChecks,
    pollIntervalMs: existing?.pollIntervalMs ?? 30_000,
    server: {
      bind: existing?.server.bind ?? (homeConfig.server?.bind ?? "127.0.0.1"),
      port,
      publicBaseUrl: homeConfig.server?.public_base_url,
    },
    database: {
      path: `${getDefaultStateDir()}/${id}.sqlite`,
      wal: existing?.database.wal ?? true,
    },
    logging: {
      level: existing?.logging.level ?? (homeConfig.logging?.level ?? "info"),
    },
    admissionLabel,
    mergeQueueCheckName,
    excludeBranches: existing?.excludeBranches ?? ["release-please--*"],
  };

  const rendered = stringifyJson(next as unknown as Record<string, unknown>);
  const status: "created" | "updated" | "unchanged" =
    !existing ? "created" : rendered === existingRaw ? "unchanged" : "updated";
  await mkdir(layout.repoConfigDir, { recursive: true });
  if (status !== "unchanged") {
    await writeFile(configPath, rendered, "utf8");
  }

  return {
    configPath,
    status,
    repo: {
      id,
      repoFullName,
      baseBranch,
      requiredChecks,
      admissionLabel,
      mergeQueueCheckName,
      port,
    },
  };
}

/**
 * Read all repo configs from the standard repo config directory.
 */
export async function loadAllRepoConfigs(): Promise<StewardConfig[]> {
  const layout = getMergeStewardPathLayout();
  if (!existsSync(layout.repoConfigDir)) return [];
  const names = await readdir(layout.repoConfigDir);
  const configs: StewardConfig[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = await readFile(`${layout.repoConfigDir}/${name}`, "utf8");
      configs.push(parseConfig(raw, { configPath: `${layout.repoConfigDir}/${name}` }));
    } catch {
      // Skip broken configs — doctor will surface them.
    }
  }
  return configs;
}
