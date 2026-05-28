import { defineConfig } from "tsup";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  // Bundle the shim (so it's included in the output) but let the shim use
  // createRequire at runtime to load the CJS libsodium, avoiding the broken ESM dist.
  noExternal: ["libsodium-wrappers"],
  esbuildOptions(options) {
    options.alias = {
      "libsodium-wrappers": path.join(__dirname, "src/libsodium-cjs.js"),
    };
  },
});
