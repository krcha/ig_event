export function getMobileNavigationHref(href: string, date: string | null): string {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return href;
  if (href === "/") return `/?month=${date.slice(0, 7)}&day=${date}`;
  if (["/discover", "/map", "/saved"].includes(href)) return `${href}?date=${date}`;
  return href;
}

// Saved/admin responses depend on identity and must never be warmed into a
// shared toolbar's route cache. Only a deliberate public-tab intent prefetches.
export function canPrefetchMobileNavigation(href: string): boolean {
  return ["/", "/discover", "/map"].includes(href.split("?")[0]);
}
