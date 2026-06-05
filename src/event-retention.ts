import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import { createGzip } from "node:zlib";
import type { PatchRelayDatabase } from "./db.ts";
import type { AppConfig } from "./types.ts";
import type { WebhookEventArchiveRecord } from "./db/webhook-event-store.ts";

export const DEFAULT_EVENT_RETENTION_DAYS = 7;
const DEFAULT_BATCH_SIZE = 1_000;

export interface EventRetentionOptions {
  now?: Date;
  batchSize?: number;
  dryRun?: boolean;
  archiveOldEvents?: boolean;
  archivePath?: string;
  retentionDays?: number;
}

export interface EventRetentionResult {
  cutoffIso: string;
  scanned: number;
  archived: number;
  deleted: number;
  remaining: number;
  archiveFile?: string | undefined;
  dryRun: boolean;
}

export async function runWebhookEventRetention(params: {
  db: PatchRelayDatabase;
  config: AppConfig;
  options?: EventRetentionOptions;
}): Promise<EventRetentionResult> {
  const retentionDays = params.options?.retentionDays
    ?? params.config.database.eventRetentionDays
    ?? DEFAULT_EVENT_RETENTION_DAYS;
  const cutoffIso = computeRetentionCutoffIso(params.options?.now ?? new Date(), retentionDays);
  const batchSize = Math.max(1, Math.floor(params.options?.batchSize ?? DEFAULT_BATCH_SIZE));
  const archiveOldEvents = params.options?.archiveOldEvents ?? params.config.database.archiveOldEvents === true;
  const archivePath = params.options?.archivePath ?? params.config.database.archivePath;
  const dryRun = params.options?.dryRun === true;

  let scanned = 0;
  let archived = 0;
  let deleted = 0;
  let writer: JsonlGzipArchiveWriter | undefined;

  if (dryRun) {
    const remaining = params.db.webhookEvents.countArchiveableEventsBefore(cutoffIso);
    return {
      cutoffIso,
      scanned: remaining,
      archived: 0,
      deleted: 0,
      remaining,
      dryRun,
    };
  }

  try {
    if (archiveOldEvents) {
      writer = await JsonlGzipArchiveWriter.create(resolveArchiveFilePath(archivePath, params.options?.now ?? new Date()));
    }

    while (true) {
      const records = params.db.webhookEvents.listArchiveableEventsBefore(cutoffIso, batchSize);
      if (records.length === 0) break;
      scanned += records.length;

      if (writer) {
        await writer.writeRecords(records);
        archived += records.length;
      }
      deleted += params.db.webhookEvents.deleteWebhookEventsByIds(records.map((record) => record.id));
      if (records.length < batchSize) break;
    }
  } finally {
    await writer?.close();
  }

  const remaining = params.db.webhookEvents.countArchiveableEventsBefore(cutoffIso);
  return {
    cutoffIso,
    scanned,
    archived,
    deleted,
    remaining,
    ...(writer?.filePath ? { archiveFile: writer.filePath } : {}),
    dryRun,
  };
}

export function computeRetentionCutoffIso(now: Date, retentionDays: number): string {
  return new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
}

function resolveArchiveFilePath(archivePath: string | undefined, now: Date): string {
  const root = archivePath ?? path.join(process.cwd(), "archive");
  const stamp = now.toISOString().replaceAll(":", "-").replaceAll(".", "-");
  return path.join(root, "webhook-events", `${stamp}.jsonl.gz`);
}

class JsonlGzipArchiveWriter {
  private constructor(
    readonly filePath: string,
    private readonly gzip: ReturnType<typeof createGzip>,
    private readonly output: ReturnType<typeof createWriteStream>,
  ) {}

  static async create(filePath: string): Promise<JsonlGzipArchiveWriter> {
    await mkdir(path.dirname(filePath), { recursive: true });
    const gzip = createGzip();
    const output = createWriteStream(filePath, { flags: "wx" });
    gzip.pipe(output);
    return new JsonlGzipArchiveWriter(filePath, gzip, output);
  }

  async writeRecords(records: WebhookEventArchiveRecord[]): Promise<void> {
    for (const record of records) {
      const line = `${JSON.stringify(record)}\n`;
      if (!this.gzip.write(line)) {
        await once(this.gzip, "drain");
      }
    }
  }

  async close(): Promise<void> {
    this.gzip.end();
    await once(this.output, "close");
  }
}
