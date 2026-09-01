import { DomainError } from "../errors";

export type RawCursorPage<T> = {
  continueCursor: string;
  isDone: boolean;
  page: T[];
};

export type VisibleCursorPage<T> = RawCursorPage<T> & {
  rawPageCount: number;
  scanLimitReached: boolean;
};

const DEFAULT_MAX_RAW_PAGES = 8;

/**
 * Fills one visible page without advancing past a row that was not examined.
 * Filtering remains a compatibility step until publication state is fully
 * materialized and backfilled. Reads are bounded by `maxRawPages`; hitting the
 * bound returns a short non-terminal page whose cursor resumes exactly after
 * the last examined raw row.
 */
export async function paginateVisibleRows<TRaw, TVisible>(options: {
  cursor: string | null;
  loadRawPage: (options: {
    cursor: string | null;
    numItems: number;
  }) => Promise<RawCursorPage<TRaw>>;
  maxRawPages?: number;
  numItems: number;
  projectVisible: (rows: TRaw[]) => Promise<TVisible[]>;
}): Promise<VisibleCursorPage<TVisible>> {
  const requested = Math.max(1, Math.trunc(options.numItems));
  const maxRawPages = Math.max(
    1,
    Math.trunc(options.maxRawPages ?? DEFAULT_MAX_RAW_PAGES),
  );
  const visibleRows: TVisible[] = [];
  let cursor = options.cursor;
  let continueCursor = options.cursor ?? "";
  let isDone = false;
  let rawPageCount = 0;

  while (visibleRows.length < requested && !isDone && rawPageCount < maxRawPages) {
    const previousCursor = cursor;
    const rawPage = await options.loadRawPage({
      cursor,
      numItems: requested - visibleRows.length,
    });
    rawPageCount += 1;

    const projected = await options.projectVisible(rawPage.page);
    if (projected.length > rawPage.page.length) {
      throw new DomainError(
        "RECONCILIATION_CONFLICT",
        "Publication projection cannot create more rows than it examines.",
      );
    }
    visibleRows.push(...projected);
    continueCursor = rawPage.continueCursor;
    isDone = rawPage.isDone;

    if (!isDone && rawPage.continueCursor === (previousCursor ?? "")) {
      throw new DomainError(
        "RECONCILIATION_CONFLICT",
        "Publication pagination cursor did not advance.",
      );
    }
    cursor = rawPage.continueCursor || null;
  }

  return {
    continueCursor,
    isDone,
    page: visibleRows,
    rawPageCount,
    scanLimitReached: !isDone && rawPageCount >= maxRawPages,
  };
}
