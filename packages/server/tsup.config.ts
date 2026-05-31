import { defineConfig } from "tsup";
import { readFileSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";

export default defineConfig({
  // index.ts = entry that auto-starts (npm run dev / Docker / `node dist/index.js`).
  // server.ts = startServer() export, hosted in-process by the bundled CLI.
  entry: ["src/index.ts", "src/server.ts"],
  format: ["esm"],
  dts: false,
  sourcemap: true,
  clean: true,
  splitting: true,
  // esbuild strips "node:" prefix from built-in imports (node:sqlite → sqlite).
  // Restore it post-build across all emitted chunks so Node resolves the built-in.
  async onSuccess() {
    for (const f of readdirSync("dist")) {
      if (!f.endsWith(".js")) continue;
      const p = join("dist", f);
      const src = readFileSync(p, "utf8").replace(/from\s*"sqlite"/g, 'from "node:sqlite"');
      writeFileSync(p, src);
    }
  },
});
