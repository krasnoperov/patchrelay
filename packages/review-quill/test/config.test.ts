import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.ts";

test("loadConfig resolves installation prompt fragments relative to the config file", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "review-quill-config-prompting-"));
  const configDir = path.join(baseDir, "config");
  const configPath = path.join(configDir, "review-quill.json");

  try {
    mkdirSync(path.join(configDir, "prompts"), { recursive: true });
    writeFileSync(path.join(configDir, "prompts", "prelude.md"), "Install prelude\n");
    writeFileSync(path.join(configDir, "prompts", "grounding.md"), "## Grounding\n\nCustom grounding\n");
    writeFileSync(configPath, JSON.stringify({
      server: { bind: "127.0.0.1", port: 8788 },
      database: { path: path.join(baseDir, "review-quill.sqlite"), wal: true },
      prompting: {
        prependFiles: ["./prompts/prelude.md"],
        replaceSections: {
          grounding: "./prompts/grounding.md",
        },
      },
      repositories: [],
    }, null, 2));

    const config = loadConfig(configPath);
    assert.equal(config.prompting.prepend[0]?.content, "Install prelude");
    assert.equal(config.prompting.replaceSections.grounding?.content, "## Grounding\n\nCustom grounding");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
