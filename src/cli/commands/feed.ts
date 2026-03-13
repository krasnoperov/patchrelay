import type { Output, ParsedArgs } from "../command-types.ts";
import type { CliOperatorDataAccess } from "../operator-client.ts";
import { formatJson } from "../formatters/json.ts";
import { formatOperatorFeed, formatOperatorFeedEvent } from "../formatters/text.ts";
import { writeOutput } from "../output.ts";

interface FeedCommandParams {
  parsed: ParsedArgs;
  json: boolean;
  stdout: Output;
  data: CliOperatorDataAccess;
}

function parseLimit(value: string | boolean | undefined): number {
  if (typeof value !== "string") {
    return 50;
  }

  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error("--limit must be a positive integer.");
  }

  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("--limit must be a positive integer.");
  }
  return parsed;
}

export async function handleFeedCommand(params: FeedCommandParams): Promise<number> {
  const limit = parseLimit(params.parsed.flags.get("limit"));
  const follow = params.parsed.flags.get("follow") === true;
  const issueFlag = params.parsed.flags.get("issue");
  const projectFlag = params.parsed.flags.get("project");
  if (issueFlag === true) {
    throw new Error("--issue requires a value.");
  }
  if (projectFlag === true) {
    throw new Error("--project requires a value.");
  }
  const issueKey = typeof issueFlag === "string" ? issueFlag.trim() || undefined : undefined;
  const projectId = typeof projectFlag === "string" ? projectFlag.trim() || undefined : undefined;
  const query = {
    limit,
    ...(issueKey ? { issueKey } : {}),
    ...(projectId ? { projectId } : {}),
  };

  if (!follow) {
    const result = await params.data.listOperatorFeed(query);
    writeOutput(
      params.stdout,
      params.json
        ? formatJson(result)
        : formatOperatorFeed(result, { color: "isTTY" in params.stdout && (params.stdout as { isTTY?: boolean }).isTTY === true }),
    );
    return 0;
  }

  if (params.json) {
    await params.data.followOperatorFeed((event) => {
      writeOutput(params.stdout, formatJson(event));
    }, query);
    return 0;
  }

  await params.data.followOperatorFeed((event) => {
    writeOutput(
      params.stdout,
      formatOperatorFeedEvent(event, { color: "isTTY" in params.stdout && (params.stdout as { isTTY?: boolean }).isTTY === true }),
    );
  }, query);
  return 0;
}
