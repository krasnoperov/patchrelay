// Shared default diff-context configuration.
//
// These constants are the single source of truth for review-quill's default
// filter lists and patch budget. They are consumed by:
//   - `config.ts` zod schema (defaults when loading on-disk config)
//   - `diff-context/local-diff.ts` `defaultDiffRepoConfig` (defaults when
//     running `review-quill diff` from any git checkout without a watched repo)
//   - `install.ts` `upsertRepoConfig` (defaults when attaching a repo)
//
// The ignore list is modeled on CodeRabbit's published defaults (lockfiles,
// build outputs, vendored deps, generated code, minified/maps). Binary files
// (images, fonts, archives) are NOT listed here — numstat already marks them
// `isBinary: true` and the classifier routes them to summarize with
// reason=binary_file, which is more useful than a silent ignore.

export const DEFAULT_DIFF_IGNORE: readonly string[] = [
  // Lockfiles — never useful to review line-by-line
  "**/package-lock.json",
  "**/yarn.lock",
  "**/pnpm-lock.yaml",
  "**/bun.lockb",
  "**/Cargo.lock",
  "**/go.sum",
  "**/Pipfile.lock",
  "**/composer.lock",
  "**/Gemfile.lock",
  "**/*.lock",
  // Build outputs and caches
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/target/**",
  "**/node_modules/**",
  "**/.next/**",
  "**/.nuxt/**",
  "**/.cache/**",
  "**/coverage/**",
  "**/.gradle/**",
  // Vendored dependencies — `**/` prefix so nested monorepo paths like
  // `packages/foo/vendor/bar.js` or `apps/web/third_party/lib.cc` are
  // caught, not just root-level vendor directories.
  "**/vendor/**",
  "**/third_party/**",
  "**/third-party/**",
  // Generated code conventions
  "**/generated/**",
  "**/__generated__/**",
  "**/@generated/**",
  "**/*.generated.*",
  "**/*.pb.go",
  "**/*.pb.cc",
  "**/*.pb.h",
  "**/*.pb.java",
  "**/*_pb2.py",
  "**/*_pb2_grpc.py",
  // Minified / source maps
  "**/*.min.js",
  "**/*.min.css",
  "**/*.map",
];

export const DEFAULT_DIFF_SUMMARIZE_ONLY: readonly string[] = [
  // Real files where the patch body is too noisy for line-by-line review,
  // but the file itself is worth naming in the inventory.
  "**/__snapshots__/**",
  "**/*.snap",
];

// Target tokens for the *patch body* portion of the rendered diff — the
// sum of `\`\`\`diff ... \`\`\`` blocks plus per-file framing. This budget
// does NOT include the inventory listing, the suppressed-file summary
// lines, repo guidance docs, or prior review comments; those land in the
// prompt separately and can add several thousand tokens on large PRs.
// See `cli.ts handleDiff` for a computed "total diff section" estimate
// that does include the other lines.
//
// 75k tokens is sized for real refactors — on a representative 90-file
// subsystem rewrite (PatchRelay's review-lens branch), 75k fits ~87/88
// files whole while dropping only the single largest file. It's the
// "knee of the curve": going higher (100k+) packs one more file at best;
// going lower (50k) drops 6-7 load-bearing files; 20k drops the whole
// core of any non-trivial refactor. Headroom budget for a 200k-token
// context model:
//
//   Diff section (this budget):       ~75k
//   Repo guidance docs (3 × 8k cap):  ~24k  (worst case)
//   Prior reviews (10 × 2k cap):      ~20k  (worst case)
//   System prompt + framing:          ~ 1k
//   Agent reasoning headroom:         ~30k+
//   ────────────────────────────────
//   Total:                            ~150k (comfortable in 200k context)
//
// Bump further (100k+) only if you see files consistently dropping to
// `budget_exceeded` on large refactors and the model still performs well.
export const DEFAULT_PATCH_BODY_BUDGET_TOKENS = 75_000;
