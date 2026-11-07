export function getMobileNavigationHref(href: string, date: string | null): string {
  const match = href.match(/^\/(en|ru)(?=\/|$)/);
  const prefix = match?.[0] ?? "";
  const path = prefix ? href.slice(prefix.length) || "/" : href;
  const localized = (next: string) => prefix ? `${prefix}${next === "/" ? "" : next}` : next;
  // Enter Map on today's events; its own date picker still supports other days.
  if (path === "/map") return localized("/map");
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return href;
  if (path === "/") return `${localized("/")}?month=${date.slice(0, 7)}&day=${date}`;
  if (["/discover", "/saved"].includes(path)) return `${localized(path)}?date=${date}`;
  return href;
}

// Saved/admin responses depend on identity and must never be warmed into a
// shared toolbar's route cache. Only a deliberate public-tab intent prefetches.
export function canPrefetchMobileNavigation(href: string): boolean {
  const path = href.split("?")[0].replace(/^\/(en|ru)(?=\/|$)/, "") || "/";
  return ["/", "/discover", "/map"].includes(path);
}
