import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runCli } from "../src/cli.ts";

function createBufferStream() {
  let buffer = "";
  return {
    stream: {
      write(chunk: string): boolean {
        buffer += chunk;
        return true;
      },
    },
    read(): string {
      return buffer;
    },
  };
}

function withEnv(values: Record<string, string | undefined>, run: () => Promise<void> | void): Promise<void> | void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  const restore = () => {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
  try {
    const result = run();
    if (result && typeof (result as Promise<void>).then === "function") {
      return (result as Promise<void>).finally(restore);
    }
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

const noop = async () => ({ exitCode: 0, stdout: "", stderr: "" });

// --- unknown command ---

test("unknown command exits 1 with usage error", async () => {
  const stderr = createBufferStream();
  const code = await runCli(["bogus"], {
    stdout: createBufferStream().stream,
    stderr: stderr.stream,
  });
  assert.equal(code, 1);
  assert.match(stderr.read(), /Unknown command: bogus/);
});

// --- missing arguments ---

test("init without url exits 1", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "ms-err-init-"));
  try {
    await withEnv(
      {
        XDG_CONFIG_HOME: path.join(baseDir, ".config"),
        XDG_STATE_HOME: path.join(baseDir, ".state"),
        XDG_DATA_HOME: path.join(baseDir, ".share"),
        MERGE_STEWARD_SYSTEMD_DIR: path.join(baseDir, "systemd"),
      },
      async () => {
        const stderr = createBufferStream();
        const code = await runCli(["init"], {
          stdout: createBufferStream().stream,
          stderr: stderr.stream,
          runCommand: noop,
        });
        assert.equal(code, 1);
        assert.match(stderr.read(), /requires <public-base-url>/);
      },
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("attach without repo exits 1", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "ms-err-attach-noargs-"));
  try {
    await withEnv(
      {
        XDG_CONFIG_HOME: path.join(baseDir, ".config"),
        XDG_STATE_HOME: path.join(baseDir, ".state"),
        XDG_DATA_HOME: path.join(baseDir, ".share"),
        MERGE_STEWARD_SYSTEMD_DIR: path.join(baseDir, "systemd"),
      },
      async () => {
        await runCli(["init", "queue.example.com"], {
          stdout: createBufferStream().stream,
          stderr: createBufferStream().stream,
          runCommand: noop,
        });

        const stderr = createBufferStream();
        const code = await runCli(["attach"], {
          stdout: createBufferStream().stream,
          stderr: stderr.stream,
          runCommand: noop,
        });
        assert.equal(code, 1);
        assert.match(stderr.read(), /requires <owner\/repo> or <id> <owner\/repo>/);
      },
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("attach with only id exits 1", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "ms-err-attach-norepo-"));
  try {
    await withEnv(
      {
        XDG_CONFIG_HOME: path.join(baseDir, ".config"),
        XDG_STATE_HOME: path.join(baseDir, ".state"),
        XDG_DATA_HOME: path.join(baseDir, ".share"),
        MERGE_STEWARD_SYSTEMD_DIR: path.join(baseDir, "systemd"),
      },
      async () => {
        await runCli(["init", "queue.example.com"], {
          stdout: createBufferStream().stream,
          stderr: createBufferStream().stream,
          runCommand: noop,
        });

        const stderr = createBufferStream();
        const code = await runCli(["attach", "app"], {
          stdout: createBufferStream().stream,
          stderr: stderr.stream,
          runCommand: noop,
        });
        assert.equal(code, 1);
        assert.match(stderr.read(), /requires <owner\/repo> or <id> <owner\/repo>/);
      },
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

// --- missing subcommands ---

test("service without subcommand exits 1", async () => {
  const stderr = createBufferStream();
  const code = await runCli(["service"], {
    stdout: createBufferStream().stream,
    stderr: stderr.stream,
    runCommand: noop,
  });
  assert.equal(code, 1);
  assert.match(stderr.read(), /requires a subcommand/);
});

test("queue without subcommand exits 1", async () => {
  const stderr = createBufferStream();
  const code = await runCli(["queue"], {
    stdout: createBufferStream().stream,
    stderr: stderr.stream,
  });
  assert.equal(code, 1);
  assert.match(stderr.read(), /requires a subcommand/);
});

// --- unknown subcommands ---

test("service unknown subcommand exits 1", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "ms-err-svc-unknown-"));
  try {
    await withEnv(
      {
        XDG_CONFIG_HOME: path.join(baseDir, ".config"),
        XDG_STATE_HOME: path.join(baseDir, ".state"),
        XDG_DATA_HOME: path.join(baseDir, ".share"),
        MERGE_STEWARD_SYSTEMD_DIR: path.join(baseDir, "systemd"),
      },
      async () => {
        await runCli(["init", "queue.example.com"], {
          stdout: createBufferStream().stream,
          stderr: createBufferStream().stream,
          runCommand: noop,
        });
        await runCli(["attach", "app", "owner/repo"], {
          stdout: createBufferStream().stream,
          stderr: createBufferStream().stream,
          runCommand: noop,
        });

        const stderr = createBufferStream();
        const code = await runCli(["service", "bogus", "app"], {
          stdout: createBufferStream().stream,
          stderr: stderr.stream,
          runCommand: noop,
        });
        assert.equal(code, 1);
        assert.match(stderr.read(), /Unknown service command: bogus/);
      },
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("queue unknown subcommand exits 1", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "ms-err-queue-unknown-"));
  try {
    await withEnv(
      {
        XDG_CONFIG_HOME: path.join(baseDir, ".config"),
        XDG_STATE_HOME: path.join(baseDir, ".state"),
        XDG_DATA_HOME: path.join(baseDir, ".share"),
        MERGE_STEWARD_SYSTEMD_DIR: path.join(baseDir, "systemd"),
      },
      async () => {
        await runCli(["init", "queue.example.com"], {
          stdout: createBufferStream().stream,
          stderr: createBufferStream().stream,
          runCommand: noop,
        });
        await runCli(["attach", "app", "owner/repo"], {
          stdout: createBufferStream().stream,
          stderr: createBufferStream().stream,
          runCommand: noop,
        });

        // use positional repo id (not --repo flag) since validateFlags
        // rejects unknown flags before the handler runs
        const stderr = createBufferStream();
        const code = await runCli(["queue", "bogus", "app"], {
          stdout: createBufferStream().stream,
          stderr: stderr.stream,
        });
        assert.equal(code, 1);
        assert.match(stderr.read(), /Unknown queue command: bogus/);
      },
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("queue watch with nonexistent repo exits 1 with a configured-repos hint instead of ENOENT", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "ms-err-queue-watch-missing-"));
  try {
    await withEnv(
      {
        XDG_CONFIG_HOME: path.join(baseDir, ".config"),
        XDG_STATE_HOME: path.join(baseDir, ".state"),
        XDG_DATA_HOME: path.join(baseDir, ".share"),
        MERGE_STEWARD_SYSTEMD_DIR: path.join(baseDir, "systemd"),
      },
      async () => {
        await runCli(["init", "queue.example.com"], {
          stdout: createBufferStream().stream,
          stderr: createBufferStream().stream,
          runCommand: noop,
        });
        await runCli(["attach", "app", "owner/repo"], {
          stdout: createBufferStream().stream,
          stderr: createBufferStream().stream,
          runCommand: noop,
        });

        const stderr = createBufferStream();
        const code = await runCli(["queue", "watch", "--repo", "missing"], {
          stdout: createBufferStream().stream,
          stderr: stderr.stream,
          runCommand: noop,
        });
        assert.equal(code, 1);
        assert.match(stderr.read(), /Repo config not found for missing/);
        assert.match(stderr.read(), /Configured repos: app/);
      },
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

// --- service commands operate on the machine-level unit ---

test("service status without repo id succeeds", async () => {
  const stdout = createBufferStream();
  const code = await runCli(["service", "status"], {
    stdout: stdout.stream,
    stderr: createBufferStream().stream,
    runCommand: async () => ({
      exitCode: 0,
      stdout: [
        "Id=merge-steward.service",
        "LoadState=loaded",
        "UnitFileState=enabled",
        "ActiveState=active",
        "SubState=running",
        "ExecMainPID=9001",
      ].join("\n"),
      stderr: "",
    }),
  });
  assert.equal(code, 0);
  assert.match(stdout.read(), /Unit: merge-steward\.service/);
});

test("service restart without repo id succeeds", async () => {
  const stdout = createBufferStream();
  const code = await runCli(["service", "restart"], {
    stdout: stdout.stream,
    stderr: createBufferStream().stream,
    runCommand: noop,
  });
  assert.equal(code, 0);
  assert.match(stdout.read(), /Restarted merge-steward\.service/);
});

test("service logs without repo id succeeds", async () => {
  const stdout = createBufferStream();
  const code = await runCli(["service", "logs"], {
    stdout: stdout.stream,
    stderr: createBufferStream().stream,
    runCommand: async () => ({ exitCode: 0, stdout: "2026-03-31 ok\n", stderr: "" }),
  });
  assert.equal(code, 0);
  assert.match(stdout.read(), /2026-03-31 ok/);
});

test("queue status without repo id exits 1", async () => {
  const stderr = createBufferStream();
  const code = await runCli(["queue", "status"], {
    stdout: createBufferStream().stream,
    stderr: stderr.stream,
  });
  assert.equal(code, 1);
  assert.match(stderr.read(), /Repo id is required/);
});

// --- queue show missing --entry or --pr ---

test("queue show without --entry or --pr exits 1", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "ms-err-show-noarg-"));
  try {
    await withEnv(
      {
        XDG_CONFIG_HOME: path.join(baseDir, ".config"),
        XDG_STATE_HOME: path.join(baseDir, ".state"),
        XDG_DATA_HOME: path.join(baseDir, ".share"),
        MERGE_STEWARD_SYSTEMD_DIR: path.join(baseDir, "systemd"),
      },
      async () => {
        await runCli(["init", "queue.example.com"], {
          stdout: createBufferStream().stream,
          stderr: createBufferStream().stream,
          runCommand: noop,
        });
        await runCli(["attach", "app", "owner/repo"], {
          stdout: createBufferStream().stream,
          stderr: createBufferStream().stream,
          runCommand: noop,
        });

        const stderr = createBufferStream();
        const code = await runCli(["queue", "show", "--repo", "app"], {
          stdout: createBufferStream().stream,
          stderr: stderr.stream,
        });
        assert.equal(code, 1);
        assert.match(stderr.read(), /requires --entry <id> or --pr <number>/);
      },
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

// --- malformed flag values ---

test("queue show --pr with non-numeric value exits 1", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "ms-err-bad-pr-"));
  try {
    await withEnv(
      {
        XDG_CONFIG_HOME: path.join(baseDir, ".config"),
        XDG_STATE_HOME: path.join(baseDir, ".state"),
        XDG_DATA_HOME: path.join(baseDir, ".share"),
        MERGE_STEWARD_SYSTEMD_DIR: path.join(baseDir, "systemd"),
      },
      async () => {
        await runCli(["init", "queue.example.com"], {
          stdout: createBufferStream().stream,
          stderr: createBufferStream().stream,
          runCommand: noop,
        });
        await runCli(["attach", "app", "owner/repo"], {
          stdout: createBufferStream().stream,
          stderr: createBufferStream().stream,
          runCommand: noop,
        });

        const stderr = createBufferStream();
        const code = await runCli(["queue", "show", "--repo", "app", "--pr", "abc"], {
          stdout: createBufferStream().stream,
          stderr: stderr.stream,
        });
        assert.equal(code, 1);
        assert.match(stderr.read(), /--pr must be a positive integer/);
      },
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("service logs --lines with non-numeric value exits 1", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "ms-err-bad-lines-"));
  try {
    await withEnv(
      {
        XDG_CONFIG_HOME: path.join(baseDir, ".config"),
        XDG_STATE_HOME: path.join(baseDir, ".state"),
        XDG_DATA_HOME: path.join(baseDir, ".share"),
        MERGE_STEWARD_SYSTEMD_DIR: path.join(baseDir, "systemd"),
      },
      async () => {
        await runCli(["init", "queue.example.com"], {
          stdout: createBufferStream().stream,
          stderr: createBufferStream().stream,
          runCommand: noop,
        });
        await runCli(["attach", "app", "owner/repo"], {
          stdout: createBufferStream().stream,
          stderr: createBufferStream().stream,
          runCommand: noop,
        });

        const stderr = createBufferStream();
        const code = await runCli(["service", "logs", "app", "--lines", "xyz"], {
          stdout: createBufferStream().stream,
          stderr: stderr.stream,
          runCommand: noop,
        });
        assert.equal(code, 1);
        assert.match(stderr.read(), /--lines must be a positive integer/);
      },
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

// --- nonexistent repo config ---

test("repos with nonexistent repo id exits 1", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "ms-err-repos-noid-"));
  try {
    await withEnv(
      {
        XDG_CONFIG_HOME: path.join(baseDir, ".config"),
        XDG_STATE_HOME: path.join(baseDir, ".state"),
        XDG_DATA_HOME: path.join(baseDir, ".share"),
        MERGE_STEWARD_SYSTEMD_DIR: path.join(baseDir, "systemd"),
      },
      async () => {
        await runCli(["init", "queue.example.com"], {
          stdout: createBufferStream().stream,
          stderr: createBufferStream().stream,
          runCommand: noop,
        });

        const stderr = createBufferStream();
        const code = await runCli(["repos", "nonexistent"], {
          stdout: createBufferStream().stream,
          stderr: stderr.stream,
        });
        assert.equal(code, 1);
        assert.match(stderr.read(), /Repo config not found/);
      },
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
