// The server is bundled (dts:false) and only consumed at runtime via the hidden
// `__relay-server` command. Declare the subpath export so the dynamic import is typed.
declare module "@agentroom/server/server" {
  export function startServer(): Promise<unknown>;
}
