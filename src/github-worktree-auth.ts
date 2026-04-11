import type { GitHubAppBotIdentity } from "./github-app-token.ts";
import { execCommand } from "./utils.ts";

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function buildGitHubBotCredentialHelper(tokenFile: string): string {
  const quotedTokenFile = shellSingleQuote(tokenFile);
  return `!f() { [ "$1" = get ] || exit 0; echo "username=x-access-token"; echo "password=$(cat ${quotedTokenFile})"; }; f`;
}

export async function configureGitHubBotAuthForWorktree(params: {
  gitBin: string;
  worktreePath: string;
  botIdentity: GitHubAppBotIdentity;
}): Promise<void> {
  const helper = buildGitHubBotCredentialHelper(params.botIdentity.tokenFile);
  const gitArgs = ["-C", params.worktreePath, "config"];

  await execCommand(params.gitBin, [...gitArgs, "user.name", params.botIdentity.name], { timeoutMs: 5_000 });
  await execCommand(params.gitBin, [...gitArgs, "user.email", params.botIdentity.email], { timeoutMs: 5_000 });

  // Clear inherited GitHub-specific helpers such as `gh auth git-credential`
  // so git HTTPS operations use the same bot token as the wrapped `gh` CLI.
  await execCommand(params.gitBin, [...gitArgs, "--replace-all", "credential.https://github.com.helper", ""], { timeoutMs: 5_000 });
  await execCommand(params.gitBin, [...gitArgs, "--add", "credential.https://github.com.helper", helper], { timeoutMs: 5_000 });
}
