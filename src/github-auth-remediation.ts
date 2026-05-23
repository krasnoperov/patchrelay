import type { Logger } from "pino";
import { execCommand } from "./utils.ts";

const GITHUB_HELPER_KEY = "credential.https://github.com.helper";
// Markers of the helper older patchrelay versions wrote into managed repo configs:
// a shell helper that cat-ed the bot token file. Either marker identifies a leaked entry.
const LEAKED_HELPER_MARKERS = ["gh-token", "x-access-token"];

/**
 * Best-effort cleanup of credentials that older patchrelay versions persisted into
 * managed repo git configs: a credential helper that read the bot token file, plus a
 * bot `user.name`/`user.email`. Those leaked the bot identity into interactive shell
 * sessions on the shared clone. The current design delivers auth purely via process env,
 * so these entries are obsolete and should be removed. Idempotent and non-fatal.
 */
export async function remediateLeakedBotAuth(params: {
  gitBin: string;
  repoPaths: string[];
  botName?: string;
  logger: Logger;
}): Promise<void> {
  for (const repoPath of new Set(params.repoPaths)) {
    try {
      const helpers = await execCommand(
        params.gitBin,
        ["-C", repoPath, "config", "--local", "--get-all", GITHUB_HELPER_KEY],
        { timeoutMs: 5_000 },
      );
      if (helpers.exitCode === 0 && LEAKED_HELPER_MARKERS.some((marker) => helpers.stdout?.includes(marker))) {
        await execCommand(params.gitBin, ["-C", repoPath, "config", "--local", "--unset-all", GITHUB_HELPER_KEY], { timeoutMs: 5_000 });
        params.logger.info({ repoPath }, "Removed leaked bot credential helper from repo git config");
      }

      if (params.botName) {
        const userName = await execCommand(params.gitBin, ["-C", repoPath, "config", "--local", "user.name"], { timeoutMs: 5_000 });
        if (userName.exitCode === 0 && userName.stdout?.trim() === params.botName) {
          await execCommand(params.gitBin, ["-C", repoPath, "config", "--local", "--unset", "user.name"], { timeoutMs: 5_000 });
          await execCommand(params.gitBin, ["-C", repoPath, "config", "--local", "--unset", "user.email"], { timeoutMs: 5_000 });
          params.logger.info({ repoPath }, "Removed leaked bot identity from repo git config");
        }
      }
    } catch (error) {
      params.logger.warn(
        { repoPath, error: error instanceof Error ? error.message : String(error) },
        "Failed to remediate leaked bot auth in repo git config (non-fatal)",
      );
    }
  }
}
