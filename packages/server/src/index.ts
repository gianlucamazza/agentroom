// Server entry — boots the relay. The bootable logic lives in server.ts
// (exported as startServer) so the bundled CLI can host it in-process without
// this module's side effect of auto-starting.
import { startServer } from "./server.js";

void startServer();
