import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { query } from "./_generated/server";
import { v } from "convex/values";
import {
  buildVenueSnapshot,
  resolveVenue,
  type VenueIdentityRecord,
  type VenueResolution,
  type VenueSnapshot,
} from "../lib/domain/venues/venue-resolver";
import { buildNormalizedEventVenueIdentity } from "../lib/events/event-venue-identity";
import {
  normalizeHandle,
  normalizeVenueComparableText,
} from "../lib/domain/venues/normalization";
import {
  getEffectiveVenueLifecycle,
  isVenuePublic,
} from "../lib/venues/venue-lifecycle";
import { requireAdminOrServiceSecret } from "./authz";

// Keep the aggregate service snapshot at a conservative application-level
// record bound below Convex transaction scan/byte limits, while leaving enough
// room for venue discovery to add canonical-name and provider-account
// identities without immediately exhausting the directory.
export const MAX_VENUE_RESOLVER_SNAPSHOT_RECORDS = 4_000;
const MAX_INDEXED_IDENTITY_MATCHES = 8;
const VENUE_RESOLVER_SNAPSHOT_SCHEMA_VERSION = "venue-resolver-snapshot-v1" as const;

const venueIdentityKind = v.union(
  v.literal("canonical_name"),
  v.literal("alias"),
  v.literal("historical_alias"),
  v.literal("provider_account"),
);

const publicVenueResolverSnapshotResult = v.object({
  schemaVersion: v.literal(VENUE_RESOLVER_SNAPSHOT_SCHEMA_VERSION),
  fingerprint: v.string(),
  venues: v.array(
    v.object({
      id: v.id("venues"),
      aliases: v.array(v.string()),
      category: v.string(),
      instagramHandle: v.string(),
      latitude: v.optional(v.number()),
      location: v.optional(v.string()),
      longitude: v.optional(v.number()),
      name: v.string(),
    }),
  ),
  identities: v.array(
    v.object({
      active: v.literal(true),
      kind: venueIdentityKind,
      provider: v.optional(v.literal("instagram")),
      value: v.string(),
      venueId: v.id("venues"),
    }),
  ),
});

export type VenueDenormalizedFields = {
  normalizedVenueIdentity?: string | undefined;
  normalizedVenueInstagramHandle?: string | undefined;
  venueCategory?: string | undefined;
  venueId?: Id<"venues"> | undefined;
  venueInstagramHandle?: string | undefined;
  venueLatitude?: number | undefined;
  venueLocation?: string | undefined;
  venueLongitude?: number | undefined;
};

export const CLEARED_VENUE_DENORMALIZED_FIELDS: VenueDenormalizedFields = {
  normalizedVenueIdentity: undefined,
  normalizedVenueInstagramHandle: undefined,
  venueCategory: undefined,
  venueId: undefined,
  venueInstagramHandle: undefined,
  venueLatitude: undefined,
  venueLocation: undefined,
  venueLongitude: undefined,
};

export type ConvexVenueSnapshot = {
  domainSnapshot: VenueSnapshot;
  venueById: ReadonlyMap<Id<"venues">, Doc<"venues">>;
};

export type ConvexVenueResolution = {
  canonicalVenueName?: string;
  lookupMode?: "indexed_identity" | "legacy_snapshot";
  resolution: VenueResolution;
  venueFields: VenueDenormalizedFields;
};

export function buildConvexVenueSnapshot(
  venues: readonly Doc<"venues">[],
  identities: readonly Doc<"venueIdentities">[] = [],
  options: { includePending?: boolean } = {},
): ConvexVenueSnapshot {
  const publicVenues = venues.filter(
    (venue) =>
      isVenuePublic(venue) ||
      (options.includePending === true &&
        getEffectiveVenueLifecycle(venue).publicStatus === "pending"),
  );
  const venueById = new Map(publicVenues.map((venue) => [venue._id, venue]));
  const identityRecords: VenueIdentityRecord[] = identities.map((identity) => ({
    active: identity.active,
    kind: identity.kind,
    ...(identity.provider ? { provider: identity.provider } : {}),
    value: identity.rawValue,
    venueId: String(identity.venueId),
  }));
  return {
    domainSnapshot: buildVenueSnapshot({
      identities: identityRecords,
      venues: publicVenues.map((venue) => ({
        aliases: venue.aliases ?? [],
        category: venue.category,
        id: String(venue._id),
        instagramHandle: venue.instagramHandle,
        latitude: venue.latitude,
        location: venue.location,
        longitude: venue.longitude,
        name: venue.name,
      })),
    }),
    venueById,
  };
}

export type BoundedPublicVenueResolverRows = {
  identities: Doc<"venueIdentities">[];
  truncated: boolean;
  venues: Doc<"venues">[];
};

/**
 * Loads the complete resolver directory under an explicit hard bound. The
 * sentinel is never returned as usable data: callers either fail closed or
 * surface an indeterminate result when `truncated` is true.
 */
export async function loadBoundedPublicVenueResolverRows(
  ctx: QueryCtx | MutationCtx,
): Promise<BoundedPublicVenueResolverRows> {
  const venueRows = await ctx.db
    .query("venues")
    .take(MAX_VENUE_RESOLVER_SNAPSHOT_RECORDS + 1);
  if (venueRows.length > MAX_VENUE_RESOLVER_SNAPSHOT_RECORDS) {
    return {
      identities: [],
      truncated: true,
      venues: venueRows
        .slice(0, MAX_VENUE_RESOLVER_SNAPSHOT_RECORDS)
        .filter(isVenuePublic),
    };
  }
  const identityKinds = [
    "canonical_name",
    "alias",
    "historical_alias",
    "provider_account",
  ] as const;
  const identityRows: Doc<"venueIdentities">[] = [];
  let remainingRecordBudget =
    MAX_VENUE_RESOLVER_SNAPSHOT_RECORDS - venueRows.length;
  let truncated = false;
  for (const kind of identityKinds) {
    const rows = await ctx.db
      .query("venueIdentities")
      .withIndex("by_active_kind", (q) => q.eq("active", true).eq("kind", kind))
      .take(remainingRecordBudget + 1);
    if (rows.length > remainingRecordBudget) {
      identityRows.push(...rows.slice(0, remainingRecordBudget));
      truncated = true;
      break;
    }
    identityRows.push(...rows);
    remainingRecordBudget -= rows.length;
  }
  const venues = venueRows.filter(isVenuePublic);
  const publicVenueIds = new Set(venues.map((venue) => venue._id));
  const identities = identityRows
    .filter((identity) => identity.active && publicVenueIds.has(identity.venueId));
  return { identities, truncated, venues };
}

export function resolveVenueFromSnapshot(
  snapshot: ConvexVenueSnapshot,
  venueName: string | undefined,
): ConvexVenueResolution {
  const rawVenueName = venueName?.trim() ?? "";
  if (!rawVenueName) {
    return {
      resolution: {
        candidates: [],
        confidence: "unknown",
        evidence: [],
        reason: "unknown",
        status: "unresolved",
      },
      venueFields: CLEARED_VENUE_DENORMALIZED_FIELDS,
    };
  }

  const resolution = resolveVenue(snapshot.domainSnapshot, {
    rawVenueClaim: rawVenueName,
    sourceRole: "promoter",
  });
  if (resolution.status !== "resolved") {
    return {
      resolution,
      venueFields: {
        ...CLEARED_VENUE_DENORMALIZED_FIELDS,
        ...buildNormalizedEventVenueIdentity({ venue: rawVenueName }),
      },
    };
  }

  const venueId = resolution.venue.id as Id<"venues">;
  const venue = snapshot.venueById.get(venueId);
  if (!venue) {
    throw new Error("Venue resolver snapshot returned a missing canonical venue.");
  }
  return {
    canonicalVenueName: venue.name,
    resolution,
    venueFields: {
      ...CLEARED_VENUE_DENORMALIZED_FIELDS,
      ...buildNormalizedEventVenueIdentity({
        venue: venue.name,
        venueInstagramHandle: venue.instagramHandle,
      }),
      venueCategory: venue.category,
      venueId: venue._id,
      venueInstagramHandle: venue.instagramHandle,
      ...(venue.latitude !== undefined ? { venueLatitude: venue.latitude } : {}),
      ...(venue.location ? { venueLocation: venue.location } : {}),
      ...(venue.longitude !== undefined ? { venueLongitude: venue.longitude } : {}),
    },
  };
}

export async function loadPublicVenueSnapshot(
  ctx: QueryCtx | MutationCtx,
): Promise<ConvexVenueSnapshot> {
  const rows = await loadBoundedPublicVenueResolverRows(ctx);
  if (rows.truncated) {
    throw new Error("Venue resolver snapshot exceeds the safe bounded load.");
  }
  return buildConvexVenueSnapshot(rows.venues, rows.identities);
}

/**
 * Authenticated service/admin boundary used by production ingestion. Only
 * public venues and their active first-class identities leave Convex, and a
 * partial directory is never returned.
 */
export const getPublicVenueResolverSnapshot = query({
  args: {
    serviceSecret: v.optional(v.string()),
  },
  returns: publicVenueResolverSnapshotResult,
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const rows = await loadBoundedPublicVenueResolverRows(ctx);
    if (rows.truncated) {
      throw new Error("Venue resolver snapshot exceeds the safe bounded load.");
    }
    const snapshot = buildConvexVenueSnapshot(rows.venues, rows.identities);
    return {
      schemaVersion: VENUE_RESOLVER_SNAPSHOT_SCHEMA_VERSION,
      fingerprint: snapshot.domainSnapshot.fingerprint,
      venues: rows.venues.map((venue) => ({
        id: venue._id,
        aliases: venue.aliases ?? [],
        category: venue.category,
        instagramHandle: venue.instagramHandle,
        ...(venue.latitude !== undefined ? { latitude: venue.latitude } : {}),
        ...(venue.location ? { location: venue.location } : {}),
        ...(venue.longitude !== undefined ? { longitude: venue.longitude } : {}),
        name: venue.name,
      })),
      identities: rows.identities.map((identity) => ({
        active: true as const,
        kind: identity.kind,
        ...(identity.provider ? { provider: identity.provider } : {}),
        value: identity.rawValue,
        venueId: identity.venueId,
      })),
    };
  },
});

function uniqueVenueIds(
  identities: readonly Doc<"venueIdentities">[],
): Id<"venues">[] {
  return [...new Set(identities.filter((identity) => identity.active).map((identity) => identity.venueId))];
}

async function loadIndexedIdentityMatches(
  ctx: QueryCtx | MutationCtx,
  rawVenueName: string,
): Promise<Doc<"venueIdentities">[]> {
  const normalizedName = normalizeVenueComparableText(rawVenueName);
  const normalizedHandle = normalizeHandle(rawVenueName);
  const nameKinds = ["canonical_name", "alias", "historical_alias"] as const;
  const batches = await Promise.all([
    ...nameKinds.map((kind) =>
      normalizedName
        ? ctx.db
            .query("venueIdentities")
            .withIndex("by_kind_normalized", (q) =>
              q.eq("kind", kind).eq("normalizedValue", normalizedName),
            )
            .take(MAX_INDEXED_IDENTITY_MATCHES + 1)
        : Promise.resolve([] as Doc<"venueIdentities">[]),
    ),
    normalizedHandle
      ? ctx.db
          .query("venueIdentities")
          .withIndex("by_provider_normalized", (q) =>
            q
              .eq("provider", "instagram")
              .eq("normalizedValue", normalizedHandle),
          )
          .take(MAX_INDEXED_IDENTITY_MATCHES + 1)
      : Promise.resolve([] as Doc<"venueIdentities">[]),
  ]);
  if (batches.some((batch) => batch.length > MAX_INDEXED_IDENTITY_MATCHES)) {
    throw new Error("Venue identity lookup exceeds the safe bounded load.");
  }
  return batches
    .flat()
    .filter(
      (identity, index, all) =>
        identity.active && all.findIndex((candidate) => candidate._id === identity._id) === index,
    );
}

async function venueIdentityMigrationReady(
  ctx: QueryCtx | MutationCtx,
): Promise<boolean> {
  const state = await ctx.db
    .query("eventDomainMigrationState")
    .withIndex("by_key", (q) => q.eq("key", "venue-identities-v1"))
    .take(2);
  if (state.length > 1) return false;
  const migration = state[0];
  return Boolean(
    migration?.completedAt &&
      migration.mismatchCount === 0 &&
      (migration.errorCount ?? 0) === 0,
  );
}

/**
 * Resolves one write-path venue through indexed identities. The bounded legacy
 * snapshot is retained only while pre-refactor venue rows have not yet been
 * backfilled into `venueIdentities`; after backfill, ordinary request-path
 * resolution does not load the venue directory.
 */
export async function resolveVenueForWrite(
  ctx: QueryCtx | MutationCtx,
  venueName: string | undefined,
  options: { includePending?: boolean } = {},
): Promise<ConvexVenueResolution> {
  const rawVenueName = venueName?.trim() ?? "";
  if (!rawVenueName) return resolveVenueFromSnapshot(buildConvexVenueSnapshot([]), rawVenueName);

  if (!(await venueIdentityMigrationReady(ctx))) {
    return {
      ...resolveVenueFromSnapshot(await loadPublicVenueSnapshot(ctx), rawVenueName),
      lookupMode: "legacy_snapshot",
    };
  }

  const identities = await loadIndexedIdentityMatches(ctx, rawVenueName);
  const venueIds = uniqueVenueIds(identities);
  if (venueIds.length > 0) {
    const venueRows = await Promise.all(venueIds.map((venueId) => ctx.db.get(venueId)));
    const publicVenues = venueRows.filter(
      (venue): venue is Doc<"venues"> =>
        venue !== null &&
        (isVenuePublic(venue) ||
          (options.includePending === true &&
            getEffectiveVenueLifecycle(venue).publicStatus === "pending")),
    );
    const resolved = resolveVenueFromSnapshot(
      buildConvexVenueSnapshot(publicVenues, identities, options),
      rawVenueName,
    );
    return { ...resolved, lookupMode: "indexed_identity" };
  }

  return {
    ...resolveVenueFromSnapshot(buildConvexVenueSnapshot([]), rawVenueName),
    lookupMode: "indexed_identity",
  };
}

/**
 * Resolves a bounded source plan without multiplying the legacy snapshot
 * fallback for every unknown claim. Indexed identities remain authoritative;
 * at most one compatibility snapshot is loaded for all misses in the batch.
 */
export async function resolveVenueClaimsForWrite(
  ctx: QueryCtx | MutationCtx,
  venueClaims: readonly string[],
): Promise<Map<string, ConvexVenueResolution>> {
  const claims = [
    ...new Set(venueClaims.map((claim) => claim.trim()).filter(Boolean)),
  ];
  if (claims.length > 64) {
    throw new Error("Venue claim batch exceeds the safe occurrence-plan bound.");
  }
  if (!(await venueIdentityMigrationReady(ctx))) {
    const compatibilitySnapshot = await loadPublicVenueSnapshot(ctx);
    return new Map(
      claims.map((claim) => [
        claim,
        {
          ...resolveVenueFromSnapshot(compatibilitySnapshot, claim),
          lookupMode: "legacy_snapshot" as const,
        },
      ]),
    );
  }
  const identityBatches = await Promise.all(
    claims.map((claim) => loadIndexedIdentityMatches(ctx, claim)),
  );
  const venueIds = uniqueVenueIds(identityBatches.flat());
  const venueRows = await Promise.all(
    venueIds.map((venueId) => ctx.db.get(venueId)),
  );
  const publicVenueById = new Map(
    venueRows
      .filter(
        (venue): venue is Doc<"venues"> =>
          venue !== null && isVenuePublic(venue),
      )
      .map((venue) => [venue._id, venue]),
  );
  const results = new Map<string, ConvexVenueResolution>();
  for (let index = 0; index < claims.length; index += 1) {
    const claim = claims[index]!;
    const identities = identityBatches[index]!;
    if (identities.length === 0) {
      results.set(claim, {
        ...resolveVenueFromSnapshot(buildConvexVenueSnapshot([]), claim),
        lookupMode: "indexed_identity",
      });
      continue;
    }
    const venues = uniqueVenueIds(identities)
      .map((venueId) => publicVenueById.get(venueId))
      .filter((venue): venue is Doc<"venues"> => Boolean(venue));
    results.set(claim, {
      ...resolveVenueFromSnapshot(
        buildConvexVenueSnapshot(venues, identities),
        claim,
      ),
      lookupMode: "indexed_identity",
    });
  }
  return results;
}
