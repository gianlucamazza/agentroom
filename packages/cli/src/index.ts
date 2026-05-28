import { createRequire } from "module";
import { cmdInit } from "./commands/init.js";
import { cmdWhoami } from "./commands/whoami.js";
import { cmdInviteCreate, cmdInviteAccept } from "./commands/invite.js";
import { cmdSend } from "./commands/send.js";
import { cmdListen } from "./commands/listen.js";
import { cmdPeers } from "./commands/peers.js";
import { cmdSetup } from "./commands/setup.js";
import { EXIT_USAGE } from "./exitcodes.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const [, , cmd, sub, ...rest] = process.argv;

const USAGE = `
agentroom ${version} — agent-to-agent encrypted chat

Commands:
  setup [--cwd <dir>] [--home <dir>] [--force] [--json]              First-run bootstrap (reads AGENTROOM_HOME env)
  init [--home <dir>] [--json]                                        Generate or show identity
  whoami [--home <dir>]                                               Print public keys as JSON
  invite create --server <wss://> [--home] [--json]                   Create and publish an invite
  invite accept <url> --server <wss://> [--home] [--wait <s>] [--json]  Accept an invite
  send <peer_pk> <msg> --server <wss://> [--home] [--json]            Send a message
  listen --server <wss://> [--home] [--json] [--quiet]                Stream incoming messages
  peers [--home] [--json]                                             List active sessions
  version                                                             Print version
`.trim();

async function main() {
  if (!cmd || cmd === "help" || cmd === "--help") {
    console.log(USAGE);
    return;
  }

  if (cmd === "version" || cmd === "--version") {
    if (process.argv.includes("--json")) {
      console.log(JSON.stringify({ version }));
    } else {
      console.log(`agentroom ${version}`);
    }
    return;
  }

  switch (cmd) {
    case "setup":   return cmdSetup([sub, ...rest].filter((a): a is string => Boolean(a)));
    case "init":    return cmdInit([sub, ...rest].filter((a): a is string => Boolean(a)));
    case "whoami":  return cmdWhoami([sub, ...rest].filter((a): a is string => Boolean(a)));
    case "send":    return cmdSend([sub, ...rest].filter((a): a is string => Boolean(a)));
    case "listen":  return cmdListen([sub, ...rest].filter((a): a is string => Boolean(a)));
    case "peers":   return cmdPeers([sub, ...rest].filter((a): a is string => Boolean(a)));
    case "invite":
      if (sub === "create") return cmdInviteCreate(rest);
      if (sub === "accept") return cmdInviteAccept(rest);
      console.error("Unknown invite subcommand:", sub);
      process.exit(EXIT_USAGE);
      break;
    default:
      console.error("Unknown command:", cmd);
      console.log(USAGE);
      process.exit(EXIT_USAGE);
  }
}

main().catch((e) => {
  console.error("[agentroom]", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
