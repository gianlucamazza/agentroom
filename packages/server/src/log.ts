type Level = "info" | "warn" | "error";

export function logEvent(level: Level, event: string, fields?: Record<string, unknown>) {
  console.log(JSON.stringify({ ts: Date.now(), level, event, ...fields }));
}
