type ReadCacheEntry = { expiresAt: number; priority?: boolean };

// A random walk through distant dates must not evict the dates people are
// browsing now. This only affects eviction; expiration and public data stay
// unchanged. UTC bounds deliberately include both sides of the local night.
export function isPriorityCalendarWindow(fromDate: string, beforeDate: string, now: number): boolean {
  const dayMs = 86_400_000;
  const key = (timestamp: number) => new Date(timestamp).toISOString().slice(0, 10);
  const from = Date.parse(`${fromDate}T12:00:00Z`);
  return Number.isFinite(from) && fromDate < beforeDate &&
    fromDate >= key(now - 2 * dayMs) && beforeDate <= key(now + 8 * dayMs) &&
    beforeDate <= key(from + 2 * dayMs);
}

export function prunePublicEventReadCache<T extends ReadCacheEntry>(
  cache: Map<string, T>, maxEntries: number, now: number,
): void {
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
  while (cache.size > maxEntries) {
    let ordinary: string | undefined;
    for (const [key, entry] of cache) {
      if (!entry.priority) { ordinary = key; break; }
    }
    const oldest = ordinary ?? cache.keys().next().value;
    if (oldest === undefined) return;
    cache.delete(oldest);
  }
}
