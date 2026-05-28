type Level = "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { error: 0, warn: 1, info: 2 };

function configuredLevel(): Level {
  const env = (process.env["LOG_LEVEL"] ?? "info").toLowerCase();
  return (env in LEVELS ? env : "info") as Level;
}

export function logEvent(level: Level, event: string, fields?: Record<string, unknown>) {
  if (LEVELS[level] > LEVELS[configuredLevel()]) return;
  console.log(JSON.stringify({ ts: Date.now(), level, event, ...fields }));
}
