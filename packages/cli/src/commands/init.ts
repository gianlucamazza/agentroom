import { loadOrCreateIdentity, identityPath } from "@agentroom/sdk";
import { toBase64 } from "@agentroom/protocol";
import { existsSync } from "fs";

export async function cmdInit(args: string[]) {
  const homeIdx = args.indexOf("--home");
  const home = homeIdx >= 0 ? args[homeIdx + 1] : undefined;
  const jsonMode = args.includes("--json");
  const idPath = identityPath(home);
  const isNew = !existsSync(idPath);

  const id = await loadOrCreateIdentity(home);
  const pk = toBase64(id.ed25519_pk);
  const x25519 = toBase64(id.x25519_pk);

  if (jsonMode) {
    console.log(JSON.stringify({ pk, x25519_pk: x25519, identity_path: idPath, created: isNew }));
    return;
  }

  if (isNew) {
    console.log("✓ Identity created:", idPath);
  } else {
    console.log("Identity already exists:", idPath);
  }
  console.log("ed25519_pk:", pk);
  console.log("x25519_pk: ", x25519);
  console.log("\nShare your ed25519_pk with peers who want to send you messages.");
}
