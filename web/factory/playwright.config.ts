import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  workers: 1,
  outputDir: "/tmp/patchrelay-factory-tests",
  use: {
    baseURL: "http://127.0.0.1:4318",
    viewport: { width: 1680, height: 1050 },
    contextOptions: { reducedMotion: "reduce" },
  },
  webServer: {
    command:
      "FACTORY_PORT=4318 node --experimental-transform-types scripts/factory-demo.ts",
    cwd: "../..",
    url: "http://127.0.0.1:4318/factory",
    reuseExistingServer: false,
  },
});
