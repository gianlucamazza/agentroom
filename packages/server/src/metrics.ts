const counters = new Map<string, number>();

// initialize baseline counters so /metrics is consistent from cold start
for (const name of [
  "ws_connections",
  "challenges_issued",
  "hello_failures",
  "messages_routed_total",
  "rate_limit_hits",
]) {
  counters.set(name, 0);
}

export function inc(name: string, by = 1) {
  counters.set(name, (counters.get(name) ?? 0) + by);
}

export function set(name: string, val: number) {
  counters.set(name, val);
}

export function snapshot(): Record<string, number> {
  return Object.fromEntries(counters);
}
