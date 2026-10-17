export function buildCalendarFilterUrl(
  pathname: string,
  formEntries: Iterable<readonly [string, unknown]>,
  currentUrl?: string,
): string {
  const params = currentUrl ? new URL(currentUrl).searchParams : new URLSearchParams();
  const entries = Array.from(formEntries);

  // Form fields may be cleared; other controls, such as Open now, retain state.
  for (const [key] of entries) params.delete(key);
  for (const [key, rawValue] of entries) {
    if (typeof rawValue !== "string") continue;
    const value = rawValue.trim();
    if (value) params.set(key, value);
  }
  params.delete("category");

  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}
