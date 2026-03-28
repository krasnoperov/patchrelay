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

function setupEnv(baseDir: string) {
  return {
    XDG_CONFIG_HOME: path.join(baseDir, ".config"),
    XDG_STATE_HOME: path.join(baseDir, ".state"),
    XDG_DATA_HOME: path.join(baseDir, ".share"),
    MERGE_STEWARD_SYSTEMD_DIR: path.join(baseDir, "systemd"),
  };
}

async function initAndAttach(baseDir: string) {
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
}

test("service logs outputs journalctl content", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "ms-svc-logs-"));
  try {
    await withEnv(setupEnv(baseDir), async () => {
      await initAndAttach(baseDir);

      const logLines = [
        "2026-03-28T10:00:00+0000 merge-steward[1234]: tick started",
        "2026-03-28T10:00:01+0000 merge-steward[1234]: tick completed",
      ].join("\n");

      const commands: string[][] = [];
      const runCommand = async (_cmd: string, args: string[]) => {
        commands.push(args);
        return { exitCode: 0, stdout: logLines + "\n", stderr: "" };
      };

      const stdout = createBufferStream();
      const code = await runCli(["service", "logs", "app"], {
        stdout: stdout.stream,
        stderr: createBufferStream().stream,
        runCommand,
      });
      assert.equal(code, 0);
      assert.match(stdout.read(), /tick started/);
      assert.match(stdout.read(), /tick completed/);
      // default 50 lines
      const journalArgs = commands.find((a) => a.includes("journalctl"))!;
      assert.ok(journalArgs.includes("50"));
    });
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("service logs --lines passes custom line count", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "ms-svc-logs-lines-"));
  try {
    await withEnv(setupEnv(baseDir), async () => {
      await initAndAttach(baseDir);

      const commands: string[][] = [];
      const runCommand = async (_cmd: string, args: string[]) => {
        commands.push(args);
        return { exitCode: 0, stdout: "log line\n", stderr: "" };
      };

      const code = await runCli(["service", "logs", "app", "--lines", "10"], {
        stdout: createBufferStream().stream,
        stderr: createBufferStream().stream,
        runCommand,
      });
      assert.equal(code, 0);
      const journalArgs = commands.find((a) => a.includes("journalctl"))!;
      assert.ok(journalArgs.includes("10"));
    });
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("service logs --json emits structured output", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "ms-svc-logs-json-"));
  try {
    await withEnv(setupEnv(baseDir), async () => {
      await initAndAttach(baseDir);

      const runCommand = async () => ({
        exitCode: 0,
        stdout: "line-one\nline-two\n",
        stderr: "",
      });

      const stdout = createBufferStream();
      const code = await runCli(["service", "logs", "app", "--json"], {
        stdout: stdout.stream,
        stderr: createBufferStream().stream,
        runCommand,
      });
      assert.equal(code, 0);
      const result = JSON.parse(stdout.read()) as { repoId: string; unit: string; lines: number; logs: string[] };
      assert.equal(result.repoId, "app");
      assert.match(result.unit, /merge-steward@app/);
      assert.equal(result.lines, 50);
      assert.deepEqual(result.logs, ["line-one", "line-two"]);
    });
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("service logs reports error on journalctl failure", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "ms-svc-logs-fail-"));
  try {
    await withEnv(setupEnv(baseDir), async () => {
      await initAndAttach(baseDir);

      const runCommand = async (_cmd: string, args: string[]) => {
        if (args.includes("journalctl")) {
          return { exitCode: 1, stdout: "", stderr: "No journal files found" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      };

      const stderr = createBufferStream();
      const code = await runCli(["service", "logs", "app"], {
        stdout: createBufferStream().stream,
        stderr: stderr.stream,
        runCommand,
      });
      assert.equal(code, 1);
      assert.match(stderr.read(), /No journal files found/);
    });
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("service restart outputs daemon-reload and restart result", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "ms-svc-restart-"));
  try {
    await withEnv(setupEnv(baseDir), async () => {
      await initAndAttach(baseDir);

      const stdout = createBufferStream();
      const code = await runCli(["service", "restart", "app"], {
        stdout: stdout.stream,
        stderr: createBufferStream().stream,
        runCommand: noop,
      });
      assert.equal(code, 0);
      const text = stdout.read();
      assert.match(text, /daemon-reload completed/);
      assert.match(text, /Restarted merge-steward@app/);
    });
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("service restart --json emits structured output", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "ms-svc-restart-json-"));
  try {
    await withEnv(setupEnv(baseDir), async () => {
      await initAndAttach(baseDir);

      const stdout = createBufferStream();
      const code = await runCli(["service", "restart", "app", "--json"], {
        stdout: stdout.stream,
        stderr: createBufferStream().stream,
        runCommand: noop,
      });
      assert.equal(code, 0);
      const result = JSON.parse(stdout.read()) as { repoId: string; daemonReloaded: boolean; restarted: boolean };
      assert.equal(result.repoId, "app");
      assert.equal(result.daemonReloaded, true);
      assert.equal(result.restarted, true);
    });
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
