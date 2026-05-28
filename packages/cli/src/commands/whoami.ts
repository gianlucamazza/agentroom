import { loadOrCreateIdentity } from "@agentroom/sdk";
import { toBase64 } from "@agentroom/protocol";

export async function cmdWhoami(args: string[]) {
  const homeIdx = args.indexOf("--home");
  const home = homeIdx >= 0 ? args[homeIdx + 1] : undefined;
  const id = await loadOrCreateIdentity(home);
  console.log(JSON.stringify({
    ed25519_pk: toBase64(id.ed25519_pk),
    x25519_pk: toBase64(id.x25519_pk),
    identity_path: id.path,
  }, null, 2));
}
