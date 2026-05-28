import { defineConfig } from "tsup";
import { readFileSync, writeFileSync } from "fs";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: false,
  sourcemap: true,
  clean: true,
  // esbuild strips "node:" prefix from built-in imports (node:sqlite → sqlite).
  // Restore it post-build so Node can resolve the built-in correctly.
  async onSuccess() {
    const dist = "dist/index.js";
    const src = readFileSync(dist, "utf8").replace(
      /from "sqlite"/g,
      'from "node:sqlite"',
    );
    writeFileSync(dist, src);
  },
});
