import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

export async function archiveWebhook(params: {
  archiveDir: string;
  webhookId: string;
  receivedAt: string;
  headers: Record<string, string | string[] | undefined>;
  rawBody: Buffer;
  payload: unknown;
}): Promise<string> {
  const datePrefix = params.receivedAt.slice(0, 10);
  const directory = path.join(params.archiveDir, datePrefix);
  const fileName = `${params.receivedAt.replace(/[:.]/g, "-")}-${sanitizePathSegment(params.webhookId)}.json`;
  const filePath = path.join(directory, fileName);

  await mkdir(directory, { recursive: true });
  await writeFile(
    filePath,
    JSON.stringify(
      {
        webhookId: params.webhookId,
        receivedAt: params.receivedAt,
        headers: params.headers,
        rawBodyUtf8: params.rawBody.toString("utf8"),
        payload: params.payload,
      },
      null,
      2,
    ),
    "utf8",
  );

  return filePath;
}
