import { defineConfig } from "tsup";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: false,
  sourcemap: true,
  clean: true,
  banner: { js: "#!/usr/bin/env node" },
  // Node v26 ESM resolver breaks libsodium-wrappers ESM path — use CJS build instead
  esbuildOptions(options) {
    options.alias = {
      "libsodium-wrappers": path.join(
        __dirname,
        "../../node_modules/libsodium-wrappers/dist/modules/libsodium-wrappers.js",
      ),
    };
  },
});
