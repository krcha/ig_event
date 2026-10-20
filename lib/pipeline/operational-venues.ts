import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import type {
  VenueIdentityRecord,
  VenueResolverRecord,
} from "../domain/venues/venue-resolver";
import { normalizeHandle } from "./venue-normalization";

export type OperationalVenueRecord = {
  name: string;
  instagramHandle: string;
  aliases?: string[];
  location?: string;
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
const getPublicVenueResolverSnapshotQuery =
  "venueResolver:getPublicVenueResolverSnapshot" as unknown as FunctionReference<"query">;
const OPERATIONAL_VENUE_PAGE_SIZE = 50;
const MAX_OPERATIONAL_VENUE_SPLIT_DEPTH = 20;

export type OperationalVenueResolverSnapshot = {
  fingerprint: string;
  identities: VenueIdentityRecord[];
  schemaVersion: "venue-resolver-snapshot-v1";
  venues: VenueResolverRecord[];
};

export async function loadOperationalVenueResolverSnapshot(options: {
  client: ConvexHttpClient;
  serviceSecret: string;
}): Promise<OperationalVenueResolverSnapshot> {
  const snapshot = (await options.client.query(getPublicVenueResolverSnapshotQuery, {
    serviceSecret: options.serviceSecret,
  })) as OperationalVenueResolverSnapshot;
  if (snapshot.schemaVersion !== "venue-resolver-snapshot-v1") {
    throw new Error("Unsupported venue resolver snapshot schema version.");
  }
  return snapshot;
}

/**
 * Projects first-class identities back into the legacy per-handle directory.
 * This keeps older prompt/context consumers working while the universal
 * resolver receives the original venue and identity rows without information
 * loss.
 */
export function buildLegacyOperationalVenueRecords(
  snapshot: Pick<OperationalVenueResolverSnapshot, "identities" | "venues">,
): OperationalVenueRecord[] {
  const venueById = new Map(snapshot.venues.map((venue) => [venue.id, venue]));
  const aliasesByVenueId = new Map<string, Set<string>>();
  const handlesByVenueId = new Map<string, Set<string>>();
  for (const venue of snapshot.venues) {
    aliasesByVenueId.set(
      venue.id,
      new Set([...(venue.aliases ?? []), venue.name].map((value) => value.trim()).filter(Boolean)),
    );
    const primaryHandle = normalizeHandle(venue.instagramHandle ?? "");
    handlesByVenueId.set(venue.id, new Set(primaryHandle ? [primaryHandle] : []));
  }
  for (const identity of snapshot.identities) {
    if (identity.active === false || !venueById.has(identity.venueId)) continue;
    if (identity.kind === "provider_account") {
      const handle = normalizeHandle(identity.value);
      if (handle) handlesByVenueId.get(identity.venueId)?.add(handle);
    } else {
      const alias = identity.value.trim();
      if (alias) aliasesByVenueId.get(identity.venueId)?.add(alias);
    }
  }

  return snapshot.venues.flatMap((venue) => {
    const aliases = [...(aliasesByVenueId.get(venue.id) ?? [])].filter(
      (alias) => alias !== venue.name,
    );
    return [...(handlesByVenueId.get(venue.id) ?? [])].map((instagramHandle) => ({
      aliases,
      instagramHandle,
      ...(venue.location ? { location: venue.location } : {}),
      name: venue.name,
    }));
  });
}

export async function loadOperationalVenueRecords(options: {
  client: ConvexHttpClient;
  serviceSecret: string;
  activeOnly: boolean;
}): Promise<OperationalVenueRecord[]> {
  const query = options.activeOnly
    ? listActiveVenueIngestionFieldsPaginatedQuery
    : listVenueIngestionFieldsPaginatedQuery;
  async function loadRange(
    startCursor: string | null,
    endCursor?: string,
    splitDepth = 0,
  ): Promise<OperationalVenueRecord[]> {
    const records: OperationalVenueRecord[] = [];
    let cursor = startCursor;
    const seenCursors = new Set<string | null>();

    while (true) {
      if (seenCursors.has(cursor)) {
        throw new Error("Operational venue pagination returned a cursor cycle.");
      }
      seenCursors.add(cursor);

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
