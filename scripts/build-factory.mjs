import { build } from "esbuild";

await build({
  entryPoints: ["web/factory/main.tsx"],
  bundle: true,
  minify: true,
  format: "esm",
  target: ["es2022"],
  outfile: "dist/factory/assets/app.js",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
});
