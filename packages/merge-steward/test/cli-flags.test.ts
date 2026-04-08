import assert from "node:assert/strict";
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

const noop = async () => ({ exitCode: 0, stdout: "", stderr: "" });

// --- unknown flags ---

test("unknown flag on init exits 1 with error", async () => {
  const stderr = createBufferStream();
  const code = await runCli(["init", "example.com", "--bogus"], {
    stdout: createBufferStream().stream,
    stderr: stderr.stream,
    runCommand: noop,
  });
  assert.equal(code, 1);
  assert.match(stderr.read(), /Unknown flag.*--bogus/);
});

test("unknown flag on repos exits 1 with error", async () => {
  const stderr = createBufferStream();
  const code = await runCli(["repos", "--bogus"], {
    stdout: createBufferStream().stream,
    stderr: stderr.stream,
  });
  assert.equal(code, 1);
  assert.match(stderr.read(), /Unknown flag.*--bogus/);
});

test("unknown flag on attach exits 1 with error", async () => {
  const stderr = createBufferStream();
  const code = await runCli(["attach", "app", "owner/repo", "--bogus"], {
    stdout: createBufferStream().stream,
    stderr: stderr.stream,
    runCommand: noop,
  });
  assert.equal(code, 1);
  assert.match(stderr.read(), /Unknown flag.*--bogus/);
});

test("unknown flag on doctor exits 1 with error", async () => {
  const stderr = createBufferStream();
  const code = await runCli(["doctor", "--bogus"], {
    stdout: createBufferStream().stream,
    stderr: stderr.stream,
  });
  assert.equal(code, 1);
  assert.match(stderr.read(), /Unknown flag.*--bogus/);
});

test("unknown flag on service status exits 1 with error", async () => {
  const stderr = createBufferStream();
  const code = await runCli(["service", "status", "app", "--bogus"], {
    stdout: createBufferStream().stream,
    stderr: stderr.stream,
    runCommand: noop,
  });
  assert.equal(code, 1);
  assert.match(stderr.read(), /Unknown flag.*--bogus/);
});

test("unknown flag on service logs exits 1 with error", async () => {
  const stderr = createBufferStream();
  const code = await runCli(["service", "logs", "app", "--bogus"], {
    stdout: createBufferStream().stream,
    stderr: stderr.stream,
    runCommand: noop,
  });
  assert.equal(code, 1);
  assert.match(stderr.read(), /Unknown flag.*--bogus/);
});

test("unknown flag on queue status exits 1 with error", async () => {
  const stderr = createBufferStream();
  const code = await runCli(["queue", "status", "--repo", "app", "--bogus"], {
    stdout: createBufferStream().stream,
    stderr: stderr.stream,
  });
  assert.equal(code, 1);
  assert.match(stderr.read(), /Unknown flag.*--bogus/);
});

test("unknown flag on queue show exits 1 with error", async () => {
  const stderr = createBufferStream();
  const code = await runCli(["queue", "show", "--repo", "app", "--bogus"], {
    stdout: createBufferStream().stream,
    stderr: stderr.stream,
  });
  assert.equal(code, 1);
  assert.match(stderr.read(), /Unknown flag.*--bogus/);
});

test("unknown flag on dashboard exits 1 with error", async () => {
  const stderr = createBufferStream();
  const code = await runCli(["dashboard", "--bogus"], {
    stdout: createBufferStream().stream,
    stderr: stderr.stream,
  });
  assert.equal(code, 1);
  assert.match(stderr.read(), /Unknown flag.*--bogus/);
});

test("multiple unknown flags are reported together", async () => {
  const stderr = createBufferStream();
  const code = await runCli(["init", "example.com", "--aaa", "--zzz"], {
    stdout: createBufferStream().stream,
    stderr: stderr.stream,
    runCommand: noop,
  });
  assert.equal(code, 1);
  assert.match(stderr.read(), /Unknown flags.*--aaa.*--zzz/);
});

// --- per-command --help flag ---

test("repos --help shows repos usage", async () => {
  const stdout = createBufferStream();
  const code = await runCli(["repos", "--help"], {
    stdout: stdout.stream,
    stderr: createBufferStream().stream,
  });
  assert.equal(code, 0);
  assert.match(stdout.read(), /merge-steward repo attach <owner\/repo>/);
});

test("attach --help shows repos usage", async () => {
  const stdout = createBufferStream();
  const code = await runCli(["attach", "--help"], {
    stdout: stdout.stream,
    stderr: createBufferStream().stream,
  });
  assert.equal(code, 0);
  assert.match(stdout.read(), /merge-steward repo attach <owner\/repo>/);
});

test("repo --help shows repo usage", async () => {
  const stdout = createBufferStream();
  const code = await runCli(["repo", "--help"], {
    stdout: stdout.stream,
    stderr: createBufferStream().stream,
  });
  assert.equal(code, 0);
  assert.match(stdout.read(), /merge-steward repo attach <owner\/repo>/);
});

test("service --help shows service usage", async () => {
  const stdout = createBufferStream();
  const code = await runCli(["service", "--help"], {
    stdout: stdout.stream,
    stderr: createBufferStream().stream,
  });
  assert.equal(code, 0);
  assert.match(stdout.read(), /merge-steward service <command>/);
});

test("queue --help shows queue usage", async () => {
  const stdout = createBufferStream();
  const code = await runCli(["queue", "--help"], {
    stdout: stdout.stream,
    stderr: createBufferStream().stream,
  });
  assert.equal(code, 0);
  assert.match(stdout.read(), /merge-steward queue <command>/);
  assert.match(stdout.read(), /dashboard \[--repo <id>\] \[--pr <number>\]/);
});

test("init --help shows root usage", async () => {
  const stdout = createBufferStream();
  const code = await runCli(["init", "--help"], {
    stdout: stdout.stream,
    stderr: createBufferStream().stream,
  });
  assert.equal(code, 0);
  assert.match(stdout.read(), /merge-steward <command>/);
});

test("doctor --help shows root usage", async () => {
  const stdout = createBufferStream();
  const code = await runCli(["doctor", "--help"], {
    stdout: stdout.stream,
    stderr: createBufferStream().stream,
  });
  assert.equal(code, 0);
  assert.match(stdout.read(), /merge-steward <command>/);
});

// --- help <topic> subcommand ---

test("help repos shows repos usage", async () => {
  const stdout = createBufferStream();
  const code = await runCli(["help", "repos"], {
    stdout: stdout.stream,
    stderr: createBufferStream().stream,
  });
  assert.equal(code, 0);
  assert.match(stdout.read(), /merge-steward repo attach <owner\/repo>/);
});

test("help repo shows repo usage", async () => {
  const stdout = createBufferStream();
  const code = await runCli(["help", "repo"], {
    stdout: stdout.stream,
    stderr: createBufferStream().stream,
  });
  assert.equal(code, 0);
  assert.match(stdout.read(), /merge-steward repo attach <owner\/repo>/);
});

test("help service shows service usage", async () => {
  const stdout = createBufferStream();
  const code = await runCli(["help", "service"], {
    stdout: stdout.stream,
    stderr: createBufferStream().stream,
  });
  assert.equal(code, 0);
  assert.match(stdout.read(), /merge-steward service <command>/);
});

test("help queue shows queue usage", async () => {
  const stdout = createBufferStream();
  const code = await runCli(["help", "queue"], {
    stdout: stdout.stream,
    stderr: createBufferStream().stream,
  });
  assert.equal(code, 0);
  assert.match(stdout.read(), /merge-steward queue <command>/);
});

test("help attach shows repos usage (alias)", async () => {
  const stdout = createBufferStream();
  const code = await runCli(["help", "attach"], {
    stdout: stdout.stream,
    stderr: createBufferStream().stream,
  });
  assert.equal(code, 0);
  assert.match(stdout.read(), /merge-steward repo attach <owner\/repo>/);
});

test("help unknown exits 1 with error", async () => {
  const stderr = createBufferStream();
  const code = await runCli(["help", "bogus"], {
    stdout: createBufferStream().stream,
    stderr: stderr.stream,
  });
  assert.equal(code, 1);
  assert.match(stderr.read(), /Unknown help topic/);
});
