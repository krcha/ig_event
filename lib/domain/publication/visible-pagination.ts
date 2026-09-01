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

/**
 * Projects exactly one raw database page into one visible page. Convex permits
 * only one paginated database query in a query or mutation execution, so a
 * compatibility filter may return a short non-terminal page. Callers must
 * continue from `continueCursor` until `isDone` instead of trying to fill the
 * page with another paginated read in the same execution.
 */
export async function paginateVisibleRows<TRaw, TVisible>(options: {
  cursor: string | null;
  loadRawPage: (options: {
    cursor: string | null;
    numItems: number;
  }) => Promise<RawCursorPage<TRaw>>;
  numItems: number;
  projectVisible: (rows: TRaw[]) => Promise<TVisible[]>;
}): Promise<VisibleCursorPage<TVisible>> {
  const requested = Math.max(1, Math.trunc(options.numItems));
  const rawPage = await options.loadRawPage({
    cursor: options.cursor,
    numItems: requested,
  });
  const visibleRows = await options.projectVisible(rawPage.page);
  if (visibleRows.length > rawPage.page.length) {
    throw new DomainError(
      "RECONCILIATION_CONFLICT",
      "Publication projection cannot create more rows than it examines.",
    );
  }
  if (
    !rawPage.isDone &&
    rawPage.continueCursor === (options.cursor ?? "")
  ) {
    throw new DomainError(
      "RECONCILIATION_CONFLICT",
      "Publication pagination cursor did not advance.",
    );
  }

  return {
    continueCursor: rawPage.continueCursor,
    isDone: rawPage.isDone,
    page: visibleRows,
    rawPageCount: 1,
    scanLimitReached: false,
  };
}
