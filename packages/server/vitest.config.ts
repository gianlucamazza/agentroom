import { defineConfig } from "vitest/config";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "libsodium-wrappers": path.join(
        __dirname,
        "../../node_modules/libsodium-wrappers/dist/modules/libsodium-wrappers.js",
      ),
    },
  },
  // Tell Vite to treat node:* builtins as external (not bundled)
  ssr: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    external: [/^node:/] as unknown as string[],
    noExternal: [],
  },
  test: {
    environment: "node",
    globals: false,
  },
});
