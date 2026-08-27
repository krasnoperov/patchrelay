import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import pino from "pino";
import { loadConfig } from "../config.ts";
import { defaultDiffRepoConfig } from "../diff-context/index.ts";
import { ReviewRunner } from "../review-runner.ts";
import { getDefaultConfigPath } from "../runtime-paths.ts";
import { loadEvalCases } from "./case-file.ts";
import { renderEvalReport } from "./report.ts";
import { runEvalCase, type EvalCaseOutcome } from "./run-case.ts";
import { prepareEvalWorktree, resolveRepositoryCheckout } from "./worktree.ts";

const execFileAsync = promisify(execFile);

interface CliOptions {
  casesDir: string;
  outputDir: string;
  configPath: string;
  reposDir?: string;
}

function usage(): string {
  return `Usage: pnpm eval [options]

Options:
  --cases <dir>       Markdown case directory (default: eval/cases)
  --out <dir>         Report directory (default: eval/results/<timestamp>)
  --config <path>     Review Quill config (default: installed config)
  --repos-dir <dir>   Parent directory containing repository checkouts
  --help              Show this help
`;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function parseArgs(args: string[]): CliOptions | undefined {
  if (args.includes("--help")) return undefined;
  args = args.filter((arg) => arg !== "--");
  let casesDir = path.resolve("eval/cases");
  let outputDir = path.resolve("eval/results", timestamp());
  let configPath = process.env.REVIEW_QUILL_CONFIG ?? getDefaultConfigPath();
  let reposDir: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    if (!["--cases", "--out", "--config", "--repos-dir"].includes(arg ?? "") || !value) {
      throw new Error(`Unknown or incomplete option: ${arg ?? ""}`);
    }
    if (arg === "--cases") casesDir = path.resolve(value);
    if (arg === "--out") outputDir = path.resolve(value);
    if (arg === "--config") configPath = path.resolve(value);
    if (arg === "--repos-dir") reposDir = path.resolve(value);
    index += 1;
  }
  return { casesDir, outputDir, configPath, ...(reposDir ? { reposDir } : {}) };
}

async function sourceIdentity(): Promise<string | undefined> {
  try {
    const commit = (await execFileAsync("git", ["rev-parse", "HEAD"], { encoding: "utf8" })).stdout.trim();
    const status = (await execFileAsync("git", ["status", "--porcelain"], { encoding: "utf8" })).stdout.trim();
    return status ? `${commit} (working tree changes)` : commit;
  } catch {
    return undefined;
  }
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  const options = parseArgs(args);
  if (!options) {
    process.stdout.write(usage());
    return 0;
  }
  const cases = await loadEvalCases(options.casesDir);
  const loadedConfig = loadConfig(options.configPath);
  const config = {
    ...loadedConfig,
    codex: {
      ...loadedConfig.codex,
      forkPriorReviewThread: false,
      reviewMode: "native-two-pass" as const,
      serviceName: "review-quill-eval",
    },
  };
  const logger = pino({ enabled: false });
  const runner = new ReviewRunner(config, logger);
  const outcomes: EvalCaseOutcome[] = [];
  const startedAt = new Date().toISOString();
  await runner.start();
  try {
    for (const evalCase of cases) {
      process.stderr.write(`Running ${evalCase.id}...\n`);
      let prepared: Awaited<ReturnType<typeof prepareEvalWorktree>> | undefined;
      try {
        const checkout = await resolveRepositoryCheckout(evalCase.repository, options.reposDir);
        prepared = await prepareEvalWorktree(evalCase, checkout);
        const configuredRepo = config.repositories.find((repo) => repo.repoFullName === evalCase.repository);
        const repository = {
          ...(configuredRepo ?? defaultDiffRepoConfig(evalCase.repository, evalCase.baseBranch)),
          reviewDocs: evalCase.reviewDocs,
        };
        outcomes.push(await runEvalCase({
          evalCase,
          config,
          repository,
          workspace: prepared.workspace,
          runner,
          logger,
          onProgress: (_threadId, turnId) => process.stderr.write(`  turn ${turnId}\n`),
        }));
      } catch (error) {
        outcomes.push({
          status: "failed",
          evalCase,
          error: error instanceof Error ? error.stack ?? error.message : String(error),
        });
      } finally {
        await prepared?.dispose();
      }
    }
  } finally {
    await runner.stop();
  }
  const commit = await sourceIdentity();
  const report = renderEvalReport({ outcomes, config, startedAt, ...(commit ? { sourceCommit: commit } : {}) });
  await mkdir(options.outputDir, { recursive: true });
  const reportPath = path.join(options.outputDir, "report.md");
  await writeFile(reportPath, report, "utf8");
  process.stdout.write(`${report}\nReport: ${reportPath}\n`);
  return outcomes.every((outcome) => outcome.status === "completed" && outcome.grade.passed) ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
