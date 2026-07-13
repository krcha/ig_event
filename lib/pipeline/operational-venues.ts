import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";

export type OperationalVenueRecord = {
  name: string;
  instagramHandle: string;
};

type OperationalVenuePage = {
  page: OperationalVenueRecord[];
  isDone: boolean;
  continueCursor: string;
  splitCursor?: string | null;
  pageStatus?: "SplitRecommended" | "SplitRequired" | null;
};

const listVenueIngestionFieldsPaginatedQuery =
  "venues:listVenueIngestionFieldsPaginated" as unknown as FunctionReference<"query">;
const listActiveVenueIngestionFieldsPaginatedQuery =
  "venues:listActiveVenueIngestionFieldsPaginated" as unknown as FunctionReference<"query">;
const OPERATIONAL_VENUE_PAGE_SIZE = 50;
const MAX_OPERATIONAL_VENUE_PAGE_REQUESTS = 1_000;
const MAX_OPERATIONAL_VENUE_SPLIT_DEPTH = 20;

export async function loadOperationalVenueRecords(options: {
  client: ConvexHttpClient;
  serviceSecret: string;
  activeOnly: boolean;
}): Promise<OperationalVenueRecord[]> {
  const query = options.activeOnly
    ? listActiveVenueIngestionFieldsPaginatedQuery
    : listVenueIngestionFieldsPaginatedQuery;
  let requestCount = 0;

  async function loadRange(
    startCursor: string | null,
    endCursor?: string,
    splitDepth = 0,
  ): Promise<OperationalVenueRecord[]> {
    const records: OperationalVenueRecord[] = [];
    let cursor = startCursor;

    while (true) {
      requestCount += 1;
      if (requestCount > MAX_OPERATIONAL_VENUE_PAGE_REQUESTS) {
        throw new Error(
          `Operational venue pagination exceeded ${MAX_OPERATIONAL_VENUE_PAGE_REQUESTS} requests.`,
        );
      }

      const result = (await options.client.query(query, {
        serviceSecret: options.serviceSecret,
        paginationOpts: {
          cursor,
          numItems: OPERATIONAL_VENUE_PAGE_SIZE,
          ...(endCursor ? { endCursor } : {}),
        },
      })) as OperationalVenuePage;

      if (result.pageStatus === "SplitRequired") {
        if (splitDepth >= MAX_OPERATIONAL_VENUE_SPLIT_DEPTH) {
          throw new Error("Operational venue pagination exceeded its split depth.");
        }
        const splitCursor = result.splitCursor;
        const continueCursor = result.continueCursor;
        if (
          !splitCursor ||
          splitCursor === cursor ||
          !continueCursor ||
          continueCursor === splitCursor ||
          continueCursor === cursor
        ) {
          throw new Error("Operational venue pagination returned an invalid required split.");
        }

        records.push(
          ...(await loadRange(cursor, splitCursor, splitDepth + 1)),
          ...(await loadRange(splitCursor, continueCursor, splitDepth + 1)),
        );
        if (result.isDone || (endCursor && continueCursor === endCursor)) {
          return records;
        }
        cursor = continueCursor;
        continue;
      }

      records.push(...result.page);
      if (result.isDone || (endCursor && result.continueCursor === endCursor)) {
        return records;
      }
      if (!result.continueCursor || result.continueCursor === cursor) {
        throw new Error("Operational venue pagination did not advance.");
      }
      cursor = result.continueCursor;
    }
  }

  return loadRange(null);
}
