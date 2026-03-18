import type { Output, ParsedArgs } from "../command-types.ts";
import type { CliOperatorDataAccess } from "../operator-client.ts";
import { formatJson } from "../formatters/json.ts";
import { formatOperatorFeed, formatOperatorFeedEvent } from "../formatters/text.ts";
import { writeOutput } from "../output.ts";
import type { OperatorFeedQuery } from "../../operator-feed.ts";

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

function readOptionalStringFlag(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.flags.get(name);
  if (value === true) {
    throw new Error(`--${name} requires a value.`);
  }
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

export async function handleFeedCommand(params: FeedCommandParams): Promise<number> {
  const limit = parseLimit(params.parsed.flags.get("limit"));
  const follow = params.parsed.flags.get("follow") === true;
  const issueKey = readOptionalStringFlag(params.parsed, "issue");
  const projectId = readOptionalStringFlag(params.parsed, "project");
  const kind = readOptionalStringFlag(params.parsed, "kind") as OperatorFeedQuery["kind"];
  const stage = readOptionalStringFlag(params.parsed, "stage");
  const status = readOptionalStringFlag(params.parsed, "status");
  const workflowId = readOptionalStringFlag(params.parsed, "workflow");
  const query: Omit<OperatorFeedQuery, "afterId"> = {
    limit,
    ...(issueKey ? { issueKey } : {}),
    ...(projectId ? { projectId } : {}),
    ...(kind ? { kind } : {}),
    ...(stage ? { stage } : {}),
    ...(status ? { status } : {}),
    ...(workflowId ? { workflowId } : {}),
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
