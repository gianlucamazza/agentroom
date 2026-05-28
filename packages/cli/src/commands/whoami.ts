import { identityPath } from "@agentroom/sdk";
import { existsSync, readFileSync } from "fs";

interface StoredIdentity {
  ed25519_pk: string;
  x25519_pk: string;
}

export async function cmdWhoami(args: string[]) {
  const homeIdx = args.indexOf("--home");
  const home = homeIdx >= 0 ? args[homeIdx + 1] : undefined;
  const idPath = identityPath(home);

  // whoami is read-only — never creates an identity
  if (!existsSync(idPath)) {
    console.error(JSON.stringify({
      error: "no identity found",
      hint: "run: agentroom init",
      identity_path: idPath,
    }));
    process.exit(1);
  }

  const raw = JSON.parse(readFileSync(idPath, "utf8")) as StoredIdentity;
  console.log(JSON.stringify({
    ed25519_pk: raw.ed25519_pk,
    x25519_pk: raw.x25519_pk,
    identity_path: idPath,
  }, null, 2));
}
