// Standalone single-file bundle of the CLI → ../../bin/agentroom.
// Self-contained (noExternal): runnable with only Node ≥22, no node_modules.
// Used for zero-install plugin distribution (file lands on PATH via plugin bin/).
import { defineConfig } from "tsup";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  entry: { agentroom: path.join(__dirname, "src/index.ts") },
  outDir: path.join(__dirname, "../../bin"),
  format: ["esm"],
  platform: "node",
  target: "node22",
  dts: false,
  sourcemap: false,
  clean: false,
  splitting: false,         // single file: inline dynamic import() of the server
  noExternal: [/.*/],       // bundle everything (@agentroom/*, ws, libsodium, zod, uuid, dotenv)
  external: ["bufferutil", "utf-8-validate"], // ws optional native speedups — ws degrades gracefully
  banner: {
    // shebang + a require() for the externals above (ws require()s them in try/catch)
    js: "#!/usr/bin/env node\nimport{createRequire as __ar_cr}from'node:module';const require=__ar_cr(import.meta.url);",
  },
  esbuildOptions(options) {
    // Node v26 ESM resolver breaks libsodium-wrappers ESM path — use CJS build instead
    options.alias = {
      "libsodium-wrappers": path.join(
        __dirname,
        "../../node_modules/libsodium-wrappers/dist/modules/libsodium-wrappers.js",
      ),
    };
  },
});
