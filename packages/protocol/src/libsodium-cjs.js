// ESM shim that loads the CJS build of libsodium-wrappers.
// The ESM dist (dist/modules-esm/) references a missing libsodium.mjs on Node v26.
// This shim uses createRequire to load the CJS build instead, avoiding the issue.
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const sodium = require("libsodium-wrappers");
export default sodium;
