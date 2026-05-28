const counters = new Map<string, number>();

export function inc(name: string, by = 1) {
  counters.set(name, (counters.get(name) ?? 0) + by);
}

export function set(name: string, val: number) {
  counters.set(name, val);
}

export function snapshot(): Record<string, number> {
  return Object.fromEntries(counters);
}
