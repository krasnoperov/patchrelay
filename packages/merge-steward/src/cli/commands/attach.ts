import { upsertRepoConfig } from "../../install.ts";
import type { ParsedArgs, Output, CommandRunner } from "../types.ts";
import { UsageError } from "../types.ts";
import { parseCsvFlag } from "../args.ts";
import { formatJson, writeOutput } from "../output.ts";
import { runSystemctl } from "../system.ts";

export async function handleAttach(parsed: ParsedArgs, stdout: Output, runCommand: CommandRunner): Promise<number> {
  const repoId = parsed.positionals[1];
  const repoFullName = parsed.positionals[2];
  if (!repoId || !repoFullName) {
    throw new UsageError("merge-steward attach requires <id> and <owner/repo>.", "repos");
  }

  const baseBranch = typeof parsed.flags.get("base-branch") === "string" ? String(parsed.flags.get("base-branch")) : undefined;
  const admissionLabel = typeof parsed.flags.get("label") === "string" ? String(parsed.flags.get("label")) : undefined;
  const mergeQueueCheckName = typeof parsed.flags.get("merge-queue-check-name") === "string"
    ? String(parsed.flags.get("merge-queue-check-name"))
    : undefined;

  const result = await upsertRepoConfig({
    id: repoId,
    repoFullName,
    ...(baseBranch ? { baseBranch } : {}),
    ...(parseCsvFlag(parsed.flags.get("required-check")).length > 0
      ? { requiredChecks: parseCsvFlag(parsed.flags.get("required-check")) }
      : {}),
    ...(admissionLabel ? { admissionLabel } : {}),
    ...(mergeQueueCheckName ? { mergeQueueCheckName } : {}),
  });

  // Restart the merge-steward service so it picks up the new repo config.
  const restartState = await runSystemctl(runCommand, ["reload-or-restart", "merge-steward.service"]);

  if (parsed.flags.get("json") === true) {
    writeOutput(stdout, formatJson({
      ...result,
      serviceRestarted: restartState.ok,
      ...(restartState.ok ? {} : { errors: [restartState.error] }),
    }));
    return restartState.ok ? 0 : 1;
  }

  writeOutput(
    stdout,
    [
      `Repo config: ${result.configPath}`,
      `${result.status === "created" ? "Attached" : result.status === "updated" ? "Updated" : "Verified"} repo ${result.repo.id} for ${result.repo.repoFullName}`,
      `Base branch: ${result.repo.baseBranch}`,
      `Admission label: ${result.repo.admissionLabel}`,
      `Queue eviction check: ${result.repo.mergeQueueCheckName}`,
      `Required checks: ${result.repo.requiredChecks.length > 0 ? result.repo.requiredChecks.join(", ") : "(any green check)"}`,
      restartState.ok
        ? "Restarted merge-steward.service"
        : `Restart failed: ${restartState.error}`,
    ].join("\n") + "\n",
  );
  return restartState.ok ? 0 : 1;
}
