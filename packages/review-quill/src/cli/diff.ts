import { buildLocalDiffContext, defaultDiffRepoConfig, detectDefaultBranch, detectRepoFullNameFromCwd, estimateTokens, renderDiffContextLines } from "../diff-context/index.ts";
import { loadConfig } from "../config.ts";
import { getDefaultConfigPath } from "../runtime-paths.ts";
import { loadRepoConfigById } from "../cli-system.ts";
import type { Output } from "./shared.ts";
import { formatJson, writeOutput } from "./shared.ts";
import { parseIntegerFlag, type ParsedArgs } from "./args.ts";
import type { ReviewQuillRepositoryConfig } from "../types.ts";

function safeListWatchedRepos(): ReviewQuillRepositoryConfig[] {
  try {
    const configPath = process.env.REVIEW_QUILL_CONFIG ?? getDefaultConfigPath();
    const config = loadConfig(configPath);
    return config.repositories;
  } catch {
    return [];
  }
}

async function resolveDiffRepoConfig(params: {
  cwd: string;
  explicitRepo?: string;
}): Promise<{ repo: ReviewQuillRepositoryConfig; source: "explicit" | "watched" | "defaults"; detectedRepoFullName?: string }> {
  if (params.explicitRepo) {
    return { repo: loadRepoConfigById(params.explicitRepo).repo as ReviewQuillRepositoryConfig, source: "explicit" };
  }
  const detected = await detectRepoFullNameFromCwd(params.cwd);
  if (detected) {
    const match = safeListWatchedRepos().find((entry) => entry.repoFullName.toLowerCase() === detected.toLowerCase());
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
  if (typeof ignore === "string") next.diffIgnore = ignore.split(",").map((entry) => entry.trim()).filter(Boolean);
  const summarize = parsed.flags.get("summarize-only");
  if (typeof summarize === "string") next.diffSummarizeOnly = summarize.split(",").map((entry) => entry.trim()).filter(Boolean);
  const budget = parseIntegerFlag(parsed.flags.get("budget"), "--budget");
  if (budget !== undefined) next.patchBodyBudgetTokens = budget;
  return next;
}

export async function handleDiff(parsed: ParsedArgs, stdout: Output): Promise<number> {
  const explicitRepo = typeof parsed.flags.get("repo") === "string" ? String(parsed.flags.get("repo")) : undefined;
  const explicitBase = typeof parsed.flags.get("base") === "string" ? String(parsed.flags.get("base")) : undefined;
  const explicitCwd = typeof parsed.flags.get("cwd") === "string" ? String(parsed.flags.get("cwd")) : undefined;
  const json = parsed.flags.get("json") === true;
  const cwd = explicitCwd ?? process.cwd();

  const resolution = await resolveDiffRepoConfig({ cwd, ...(explicitRepo ? { explicitRepo } : {}) });
  const repo = applyDiffConfigOverrides(resolution.repo, parsed);

  const { workspace, diff } = await buildLocalDiffContext({
    repo,
    cwd,
    ...(explicitBase ? { baseRef: explicitBase } : {}),
  });

  const body = renderDiffContextLines(diff);

  if (json) {
    const diffSectionTokens = estimateTokens(body.join("\n"));
    const patchBodyTokens = diff.patches.reduce(
      (sum, entry) => sum + estimateTokens(entry.patch) + 23,
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

  writeOutput(stdout, `${body.join("\n")}\n`);
  return 0;
}
