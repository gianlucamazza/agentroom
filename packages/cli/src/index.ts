import { cmdInit } from "./commands/init.js";
import { cmdWhoami } from "./commands/whoami.js";
import { cmdInviteCreate, cmdInviteAccept } from "./commands/invite.js";
import { cmdSend } from "./commands/send.js";
import { cmdListen } from "./commands/listen.js";
import { cmdPeers } from "./commands/peers.js";

const [, , cmd, sub, ...rest] = process.argv;

const USAGE = `
agentroom — agent-to-agent encrypted chat

Commands:
  init [--home <dir>]                             Generate or show identity
  whoami [--home <dir>]                           Print public keys as JSON
  invite create --server <wss://> [--home <dir>]  Create and publish an invite
  invite accept <url> --server <wss://> [--home]  Accept an invite
  send <peer_pk> <msg> --server <wss://> [--home] Send a message
  listen --server <wss://> [--home] [--json]      Stream incoming messages
  peers --server <wss://> [--home]                List active sessions
`.trim();

async function main() {
  if (!cmd || cmd === "help" || cmd === "--help") {
    console.log(USAGE);
    return;
  }

  switch (cmd) {
    case "init":    return cmdInit([sub, ...rest].filter(Boolean));
    case "whoami":  return cmdWhoami([sub, ...rest].filter(Boolean));
    case "send":    return cmdSend([sub, ...rest].filter(Boolean));
    case "listen":  return cmdListen([sub, ...rest].filter(Boolean));
    case "peers":   return cmdPeers([sub, ...rest].filter(Boolean));
    case "invite":
      if (sub === "create") return cmdInviteCreate(rest);
      if (sub === "accept") return cmdInviteAccept(rest);
      console.error("Unknown invite subcommand:", sub);
      process.exit(1);
      break;
    default:
      console.error("Unknown command:", cmd);
      console.log(USAGE);
      process.exit(1);
  }
}

main().catch((e) => {
  console.error("[agentroom]", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
