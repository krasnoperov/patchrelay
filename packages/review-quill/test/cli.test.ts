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

test("help shows dashboard in the root command surface", async () => {
  const stdout = createBufferStream();
  const code = await runCli(["help"], {
    stdout: stdout.stream,
    stderr: createBufferStream().stream,
  });

  assert.equal(code, 0);
  assert.match(stdout.read(), /dashboard \[--config <path>\]/);
  assert.match(stdout.read(), /Everyday commands:/);
  assert.match(stdout.read(), /repo attach <owner\/repo>/);
});

test("unknown command prints help and exits 1", async () => {
  const stderr = createBufferStream();
  const code = await runCli(["dashboard1"], {
    stdout: createBufferStream().stream,
    stderr: stderr.stream,
  });

  assert.equal(code, 1);
  assert.match(stderr.read(), /review-quill/);
  assert.match(stderr.read(), /Command help:/);
  assert.match(stderr.read(), /Error: Unknown command: dashboard1/);
});

test("repo help and alias help both describe the repo command surface", async () => {
  const repoHelp = createBufferStream();
  assert.equal(await runCli(["repo", "--help"], {
    stdout: repoHelp.stream,
    stderr: createBufferStream().stream,
  }), 0);
  assert.match(repoHelp.read(), /review-quill repo attach <owner\/repo>/);

  const aliasHelp = createBufferStream();
  assert.equal(await runCli(["attach", "--help"], {
    stdout: aliasHelp.stream,
    stderr: createBufferStream().stream,
  }), 0);
  assert.match(aliasHelp.read(), /review-quill repo attach <owner\/repo>/);
});
