import git from "isomorphic-git";
import { Volume } from "memfs";
import type { GitOperations } from "../interfaces.ts";
import type { MergeResult, RebaseResult } from "../types.ts";

const AUTHOR = { name: "steward-sim", email: "sim@test" };

function isMergeConflict(err: unknown): boolean {
  const code = (err as { code?: string }).code;
  return code === "MergeConflictError" || code === "MergeNotSupportedError";
}

/**
 * In-memory git implementation using isomorphic-git + memfs.
 * Rebase is simulated as merge (same end-state, different history shape).
 */
export class GitSim implements GitOperations {
  private readonly vol: InstanceType<typeof Volume>;
  private readonly dir = "/repo";

  constructor() {
    this.vol = new Volume();
  }

  /** Expose volume for test introspection. */
  get volume(): InstanceType<typeof Volume> {
    return this.vol;
  }

  get repoDir(): string {
    return this.dir;
  }

  /** Initialize the repo with an initial commit on the base branch. */
  async init(baseBranch: string): Promise<string> {
    await this.vol.promises.mkdir(this.dir, { recursive: true });
    await git.init({ fs: this.vol, dir: this.dir, defaultBranch: baseBranch });
    await this.vol.promises.writeFile(`${this.dir}/.gitkeep`, "");
    await git.add({ fs: this.vol, dir: this.dir, filepath: ".gitkeep" });
    const sha = await git.commit({
      fs: this.vol,
      dir: this.dir,
      message: "initial",
      author: AUTHOR,
    });
    return sha;
  }

  /** Write a file and commit it on the current branch. */
  async commitFile(filePath: string, content: string, message: string): Promise<string> {
    const fullPath = `${this.dir}/${filePath}`;
    const parentDir = fullPath.substring(0, fullPath.lastIndexOf("/"));
    if (parentDir !== this.dir) {
      await this.vol.promises.mkdir(parentDir, { recursive: true });
    }
    await this.vol.promises.writeFile(fullPath, content);
    await git.add({ fs: this.vol, dir: this.dir, filepath: filePath });
    return git.commit({
      fs: this.vol,
      dir: this.dir,
      message,
      author: AUTHOR,
    });
  }

  /** Read a file from the working directory. */
  async readFile(filePath: string): Promise<string> {
    return this.vol.promises.readFile(`${this.dir}/${filePath}`, "utf8") as Promise<string>;
  }

  /** Check if a file exists in the working directory. */
  async fileExists(filePath: string): Promise<boolean> {
    try {
      await this.vol.promises.access(`${this.dir}/${filePath}`);
      return true;
    } catch {
      return false;
    }
  }

  // --- GitOperations interface ---

  async fetch(): Promise<void> {
    // No-op in sim — no remote.
  }

  async headSha(branch: string): Promise<string> {
    return git.resolveRef({ fs: this.vol, dir: this.dir, ref: branch });
  }

  async changedFiles(branch: string, base: string): Promise<string[]> {
    const branchSha = await this.headSha(branch);
    const baseSha = await this.headSha(base);

    const branchTree = git.TREE({ ref: branchSha });
    const baseTree = git.TREE({ ref: baseSha });

    const changes: string[] = [];
    await git.walk({
      fs: this.vol,
      dir: this.dir,
      trees: [baseTree, branchTree],
      map: async (filepath, entries) => {
        if (!entries || filepath === ".") return undefined;
        const [baseEntry, branchEntry] = entries;
        const baseOid = baseEntry ? await baseEntry.oid() : null;
        const branchOid = branchEntry ? await branchEntry.oid() : null;
        if (baseOid !== branchOid) {
          changes.push(filepath);
        }
        return undefined;
      },
    });

    return changes;
  }

  async rebase(branch: string, onto: string): Promise<RebaseResult> {
    // Simulated as merge — produces the same content, different history shape.
    // For queue testing, the content outcome is what matters.
    const currentBranch = await git.currentBranch({ fs: this.vol, dir: this.dir });
    await git.checkout({ fs: this.vol, dir: this.dir, ref: branch, force: true });

    try {
      const result = await git.merge({
        fs: this.vol,
        dir: this.dir,
        ours: branch,
        theirs: onto,
        author: AUTHOR,
      });
      if (result.alreadyMerged) {
        return { success: true, newHeadSha: await this.headSha(branch) };
      }
      await git.checkout({ fs: this.vol, dir: this.dir, ref: branch, force: true });
      return { success: true, newHeadSha: result.oid };
    } catch (err: unknown) {
      if (isMergeConflict(err)) {
        // Reset to pre-merge state
        await git.checkout({ fs: this.vol, dir: this.dir, ref: branch, force: true });
        // Detect which files conflict
        const branchFiles = await this.changedFiles(branch, onto);
        const ontoFiles = await this.changedFiles(onto, branch);
        const conflicts = branchFiles.filter((f) => ontoFiles.includes(f));
        return { success: false, conflictFiles: conflicts.length > 0 ? conflicts : ["unknown"] };
      }
      throw err;
    } finally {
      if (currentBranch) {
        try {
          await git.checkout({ fs: this.vol, dir: this.dir, ref: currentBranch, force: true });
        } catch {
          // Ignore — branch may not exist after failed merge
        }
      }
    }
  }

  async merge(source: string, into: string): Promise<MergeResult> {
    await git.checkout({ fs: this.vol, dir: this.dir, ref: into, force: true });
    try {
      const result = await git.merge({
        fs: this.vol,
        dir: this.dir,
        ours: into,
        theirs: source,
        author: AUTHOR,
      });
      await git.checkout({ fs: this.vol, dir: this.dir, ref: into, force: true });
      return { success: true, sha: result.oid };
    } catch (err: unknown) {
      if (isMergeConflict(err)) {
        await git.checkout({ fs: this.vol, dir: this.dir, ref: into, force: true });
        return { success: false };
      }
      throw err;
    }
  }

  async push(): Promise<void> {
    // No-op in sim — no remote.
  }

  async createBranch(name: string, from: string): Promise<void> {
    const sha = await this.headSha(from);
    await git.branch({ fs: this.vol, dir: this.dir, ref: name, object: sha });
  }

  async deleteBranch(name: string): Promise<void> {
    await git.deleteBranch({ fs: this.vol, dir: this.dir, ref: name });
  }
}
