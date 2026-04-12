import type { StewardConfig } from "./config.ts";
import type { MergeStewardService } from "./service.ts";
import type { SqliteStore } from "./db/sqlite-store.ts";
import type { RepoRuntimeState } from "./admin-types.ts";

export interface RepoInstance {
  config: StewardConfig;
  service: MergeStewardService;
  store: SqliteStore;
}

export interface RepoRuntimeRecord {
  config: StewardConfig;
  state: RepoRuntimeState;
  startedAt: string;
  readyAt?: string | undefined;
  failedAt?: string | undefined;
  lastError?: string | undefined;
  instance?: RepoInstance | undefined;
}
