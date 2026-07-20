export const PUBLIC_VENUE_DIRECTORY_PAGE_SIZE = 12;
export const MAX_PUBLIC_VENUE_DIRECTORY_PAGE_SIZE = 50;

export function buildPublicVenueDirectoryPageHref(params: {
  category?: string;
  page?: string;
  q?: string;
  upcoming?: string;
}): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) {
      query.set(key, value);
    }
  }
  const serialized = query.toString();
  return serialized ? `?${serialized}` : "";
}

export function normalizePublicVenueDirectoryPage(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "1", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

export function paginatePublicVenueDirectory<T>(
  venues: readonly T[],
  requestedPage: number,
  pageSize = PUBLIC_VENUE_DIRECTORY_PAGE_SIZE,
): {
  currentPage: number;
  firstItemNumber: number;
  lastItemNumber: number;
  pageItems: T[];
  totalPages: number;
} {
  const boundedPageSize = Math.max(
    1,
    Math.min(MAX_PUBLIC_VENUE_DIRECTORY_PAGE_SIZE, Math.trunc(pageSize)),
  );
  const totalPages = Math.max(1, Math.ceil(venues.length / boundedPageSize));
  const currentPage = Math.min(Math.max(1, Math.trunc(requestedPage)), totalPages);
  const startIndex = (currentPage - 1) * boundedPageSize;
  const pageItems = venues.slice(startIndex, startIndex + boundedPageSize);

  return {
    currentPage,
    firstItemNumber: pageItems.length > 0 ? startIndex + 1 : 0,
    lastItemNumber: startIndex + pageItems.length,
    pageItems,
    totalPages,
  };
}
