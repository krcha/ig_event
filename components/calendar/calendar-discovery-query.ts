const queryKeys = ["category", "time", "genre", "format", "hide"] as const;
type DiscoveryQueryKey = (typeof queryKeys)[number];

export function copyCalendarDiscoveryFilters(target: URLSearchParams, source: Pick<URLSearchParams, "get">) {
  for (const key of queryKeys) {
    const value = source.get(key);
    if (value) target.set(key, value);
    else target.delete(key);
  }
}

/** These facets only refine data already in the selected-day payload. */
export function replaceCalendarDiscoveryFilters(values: Partial<Record<DiscoveryQueryKey, string | null>>) {
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(values)) {
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  }
  if (url.href !== window.location.href) window.history.replaceState(null, "", url);
}
