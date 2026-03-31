import { existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { exec } from "../exec.ts";
import type { Logger } from "pino";

/**
 * Manages a local clone of the repository for the steward to operate in.
 * The clone is created on first use and fetched before operations.
 */
export class CloneManager {
  constructor(
    private readonly clonePath: string,
    private readonly repoUrl: string,
    private readonly repoFullName: string,
    private readonly gitBin: string = "git",
    private readonly logger?: Logger,
  ) {}

  /** Ensure the clone exists. Creates it if missing. */
  async ensureClone(): Promise<void> {
    if (existsSync(join(this.clonePath, ".git"))) {
      this.logger?.debug({ clonePath: this.clonePath }, "Clone exists");
      return;
    }

    this.logger?.info({ clonePath: this.clonePath, repoUrl: this.repoUrl }, "Cloning repository");
    mkdirSync(dirname(this.clonePath), { recursive: true });
    await exec(this.gitBin, ["clone", this.repoUrl, this.clonePath], {
      timeoutMs: 300_000,
      githubRepoFullName: this.repoFullName,
    });

    // Configure merge quality settings.
    const gitC = ["-C", this.clonePath, "config"];
    await exec(this.gitBin, [...gitC, "merge.conflictStyle", "zdiff3"], {
      githubRepoFullName: this.repoFullName,
    }).catch(() => {});
    await exec(this.gitBin, [...gitC, "rerere.enabled", "true"], {
      githubRepoFullName: this.repoFullName,
    }).catch(() => {});

    this.logger?.info("Clone complete");
  }

  /** Fetch latest from origin. */
  async fetch(): Promise<void> {
    this.logger?.debug("Fetching origin");
    await exec(this.gitBin, ["-C", this.clonePath, "fetch", "origin", "--prune"], {
      timeoutMs: 60_000,
      githubRepoFullName: this.repoFullName,
    });
  }

  /** Get the clone path. */
  get path(): string {
    return this.clonePath;
  }
}
