import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import {
  deactivateVenueIdentities,
  upsertClaim,
} from "../../venueIdentities";
import { normalizeHandle } from "../../../lib/pipeline/venue-normalization";
import {
  recordEventDomainMigrationProgress,
  type EventDomainMigrationBatchArgs,
  type EventDomainMigrationBatchCounts,
} from "./eventDomainShared";

export const REVIEWED_KOLARAC_VENUE_CONSOLIDATION_KEY =
  "reviewed-kolarac-venue-consolidation-v1";

const CANONICAL_HANDLE = "kolarac_kolarceva_zaduzbina";
const CANONICAL_NAME = "Kolarac";
const LEGACY_HANDLE = "kolarac_art_bioskop";
const LEGACY_NAME = "KolaracArtBioskop";
const MAX_HANDLE_CANDIDATES = 2;
const MAX_IDENTITIES_PER_KIND = 50;
const MAX_INSTAGRAM_SOURCE_DIRECTORY = 2_000;
const MAX_AUDIT_ROWS_PER_VENUE = 100;
const MIGRATION_ACTOR = "reviewed-kolarac-venue-consolidation-v1";
const LEGACY_AUDIT_ACTION =
  "reviewed_kolarac_venue_consolidation_legacy_deactivated";
const CANONICAL_AUDIT_ACTION =
  "reviewed_kolarac_venue_consolidation_canonical_promoted";
const AUDIT_NOTE =
  "Human-reviewed duplicate venue consolidation: kolarac_art_bioskop belongs to canonical Kolarac.";

type KolaracVenue = Doc<"venues">;
type KolaracSource = Doc<"instagramSources">;
type KolaracIdentity = Doc<"venueIdentities">;

type Inspection = {
  canonical: KolaracVenue | null;
  canonicalAuditRows: Doc<"venueAuditLog">[];
  canonicalLegacyHandleIdentity: KolaracIdentity | null;
  canonicalSource: KolaracSource | null;
  issues: string[];
  legacy: KolaracVenue | null;
  legacyAuditRows: Doc<"venueAuditLog">[];
  legacyIdentities: KolaracIdentity[];
  legacySource: KolaracSource | null;
  state: "blocked" | "post_apply" | "pre_apply";
};

function stableUniqueById<T extends { _id: unknown }>(rows: readonly T[]): T[] {
  return [
    ...new Map(rows.map((row) => [String(row._id), row])).values(),
  ];
}

async function loadVenueCandidates(
  ctx: MutationCtx,
  handle: string,
): Promise<KolaracVenue[]> {
  const normalizedHandle = normalizeHandle(handle);
  const batches = await Promise.all([
    ctx.db
      .query("venues")
      .withIndex("by_normalizedInstagramHandle", (q) =>
        q.eq("normalizedInstagramHandle", normalizedHandle),
      )
      .take(MAX_HANDLE_CANDIDATES + 1),
    ctx.db
      .query("venues")
      .withIndex("by_instagramHandle", (q) =>
        q.eq("instagramHandle", normalizedHandle),
      )
      .take(MAX_HANDLE_CANDIDATES + 1),
    ctx.db
      .query("venues")
      .withIndex("by_instagramHandle", (q) =>
        q.eq("instagramHandle", `@${normalizedHandle}`),
      )
      .take(MAX_HANDLE_CANDIDATES + 1),
  ]);
  return stableUniqueById(batches.flat());
}

async function loadSourceCandidates(
  ctx: MutationCtx,
  handle: string,
): Promise<KolaracSource[]> {
  const normalizedHandle = normalizeHandle(handle);
  const batches = await Promise.all([
    ctx.db
      .query("instagramSources")
      .withIndex("by_handle", (q) => q.eq("handle", normalizedHandle))
      .take(MAX_HANDLE_CANDIDATES + 1),
    ctx.db
      .query("instagramSources")
      .withIndex("by_handle", (q) => q.eq("handle", `@${normalizedHandle}`))
      .take(MAX_HANDLE_CANDIDATES + 1),
  ]);
  return stableUniqueById(batches.flat());
}

async function loadVenueIdentities(
  ctx: MutationCtx,
  venueId: Id<"venues">,
): Promise<{ identities: KolaracIdentity[]; overBound: boolean }> {
  const batches = await Promise.all(
    (
      [
        "canonical_name",
        "alias",
        "historical_alias",
        "provider_account",
      ] as const
    ).map((kind) =>
      ctx.db
        .query("venueIdentities")
        .withIndex("by_venue_kind", (q) =>
          q.eq("venueId", venueId).eq("kind", kind),
        )
        .take(MAX_IDENTITIES_PER_KIND + 1),
    ),
  );
  return {
    identities: batches.flat(),
    overBound: batches.some(
      (batch) => batch.length > MAX_IDENTITIES_PER_KIND,
    ),
  };
}

async function loadVenueAuditRows(
  ctx: MutationCtx,
  venueId: Id<"venues">,
): Promise<{ overBound: boolean; rows: Doc<"venueAuditLog">[] }> {
  const rows = await ctx.db
    .query("venueAuditLog")
    .withIndex("by_venue", (q) => q.eq("venueId", venueId))
    .take(MAX_AUDIT_ROWS_PER_VENUE + 1);
  return {
    overBound: rows.length > MAX_AUDIT_ROWS_PER_VENUE,
    rows: rows.slice(0, MAX_AUDIT_ROWS_PER_VENUE),
  };
}

function exactVenueRecord(
  venue: KolaracVenue,
  expected: { handle: string; name: string },
): boolean {
  return (
    venue.name === expected.name &&
    venue.category === "venue" &&
    venue.instagramHandle === expected.handle &&
    venue.normalizedInstagramHandle === expected.handle
  );
}

function sourceHasExactRoleAndHandle(
  source: KolaracSource,
  handle: string,
): boolean {
  return (
    source.active === true &&
    source.role === "venue" &&
    source.handle === handle
  );
}

function isLegacyPreLifecycle(venue: KolaracVenue): boolean {
  return (
    venue.isActive === true &&
    ((venue.publicStatus === undefined && venue.scrapeActive === undefined) ||
      (venue.publicStatus === "published" && venue.scrapeActive === true))
  );
}

function isLegacyPostLifecycle(venue: KolaracVenue): boolean {
  return (
    venue.isActive === false &&
    venue.publicStatus === "hidden" &&
    venue.scrapeActive === false
  );
}

function isCanonicalLifecycle(venue: KolaracVenue): boolean {
  return (
    venue.isActive === true &&
    venue.publicStatus === "published" &&
    venue.scrapeActive === true
  );
}

function isExactCanonicalLegacyHandleIdentity(
  identity: KolaracIdentity,
  canonicalVenueId: Id<"venues">,
): boolean {
  return (
    identity.venueId === canonicalVenueId &&
    identity.kind === "provider_account" &&
    identity.provider === "instagram" &&
    identity.normalizedValue === LEGACY_HANDLE &&
    identity.rawValue === LEGACY_HANDLE &&
    identity.active === true &&
    identity.source === "manual"
  );
}

function exactAuditRows(options: {
  action: string;
  afterJson: string;
  beforeJson: string | readonly string[];
  rows: readonly Doc<"venueAuditLog">[];
}): boolean {
  const matches = options.rows.filter((row) => row.action === options.action);
  const allowedBeforeJson = Array.isArray(options.beforeJson)
    ? options.beforeJson
    : [options.beforeJson];
  return (
    matches.length === 1 &&
    matches[0].actor === MIGRATION_ACTOR &&
    matches[0].note === AUDIT_NOTE &&
    allowedBeforeJson.includes(matches[0].beforeJson) &&
    matches[0].afterJson === options.afterJson
  );
}

function legacyAfterAuditJson(): string {
  return JSON.stringify({
    isActive: false,
    publicStatus: "hidden",
    scrapeActive: false,
  });
}

function canonicalAfterAuditJson(canonicalVenueId: Id<"venues">): string {
  return JSON.stringify({
    instagramSourceHandle: LEGACY_HANDLE,
    instagramSourceVenueId: String(canonicalVenueId),
    identity: {
      active: true,
      kind: "provider_account",
      normalizedValue: LEGACY_HANDLE,
      provider: "instagram",
      rawValue: LEGACY_HANDLE,
      source: "manual",
      venueId: String(canonicalVenueId),
    },
  });
}

async function inspectKolaracConsolidation(
  ctx: MutationCtx,
): Promise<Inspection> {
  const issues: string[] = [];
  const [canonicalCandidates, legacyCandidates] = await Promise.all([
    loadVenueCandidates(ctx, CANONICAL_HANDLE),
    loadVenueCandidates(ctx, LEGACY_HANDLE),
  ]);
  if (canonicalCandidates.length !== 1) {
    issues.push("canonical_venue_not_unique");
  }
  if (legacyCandidates.length !== 1) {
    issues.push("legacy_venue_not_unique");
  }
  const canonical =
    canonicalCandidates.length === 1 ? canonicalCandidates[0] : null;
  const legacy = legacyCandidates.length === 1 ? legacyCandidates[0] : null;
  if (canonical && legacy && canonical._id === legacy._id) {
    issues.push("canonical_and_legacy_venue_are_same_row");
  }
  if (
    canonical &&
    !exactVenueRecord(canonical, {
      handle: CANONICAL_HANDLE,
      name: CANONICAL_NAME,
    })
  ) {
    issues.push("canonical_venue_shape_drifted");
  }
  if (canonical && !isCanonicalLifecycle(canonical)) {
    issues.push("canonical_venue_lifecycle_drifted");
  }
  if (
    legacy &&
    !exactVenueRecord(legacy, { handle: LEGACY_HANDLE, name: LEGACY_NAME })
  ) {
    issues.push("legacy_venue_shape_drifted");
  }

  const [canonicalSources, legacySources, sourceDirectory] = await Promise.all([
    loadSourceCandidates(ctx, CANONICAL_HANDLE),
    loadSourceCandidates(ctx, LEGACY_HANDLE),
    ctx.db
      .query("instagramSources")
      .take(MAX_INSTAGRAM_SOURCE_DIRECTORY + 1),
  ]);
  if (sourceDirectory.length > MAX_INSTAGRAM_SOURCE_DIRECTORY) {
    issues.push("instagram_source_directory_over_bound");
  }
  if (canonicalSources.length !== 1) {
    issues.push("canonical_instagram_source_not_unique");
  }
  if (legacySources.length !== 1) {
    issues.push("legacy_instagram_source_not_unique");
  }
  const canonicalSource =
    canonicalSources.length === 1 ? canonicalSources[0] : null;
  const legacySource = legacySources.length === 1 ? legacySources[0] : null;
  if (
    canonicalSource &&
    (!sourceHasExactRoleAndHandle(canonicalSource, CANONICAL_HANDLE) ||
      canonicalSource.venueId !== canonical?._id)
  ) {
    issues.push("canonical_instagram_source_relationship_drifted");
  }
  if (
    legacySource &&
    !sourceHasExactRoleAndHandle(legacySource, LEGACY_HANDLE)
  ) {
    issues.push("legacy_instagram_source_shape_drifted");
  }

  let legacyIdentities: KolaracIdentity[] = [];
  let canonicalLegacyHandleIdentity: KolaracIdentity | null = null;
  let legacyAuditRows: Doc<"venueAuditLog">[] = [];
  let canonicalAuditRows: Doc<"venueAuditLog">[] = [];
  if (canonical && legacy) {
    const [
      eventReferences,
      sourceOccurrenceReferences,
      favoriteReferences,
      loadedLegacyIdentities,
      loadedCanonicalIdentities,
      providerAccountMatches,
      loadedLegacyAuditRows,
      loadedCanonicalAuditRows,
    ] = await Promise.all([
      ctx.db
        .query("events")
        .withIndex("by_venueId", (q) => q.eq("venueId", legacy._id))
        .take(1),
      ctx.db
        .query("sourceOccurrences")
        .withIndex("by_venue", (q) => q.eq("venueId", legacy._id))
        .take(1),
      ctx.db
        .query("favoriteVenues")
        .withIndex("by_venue", (q) => q.eq("venueId", legacy._id))
        .take(1),
      loadVenueIdentities(ctx, legacy._id),
      loadVenueIdentities(ctx, canonical._id),
      ctx.db
        .query("venueIdentities")
        .withIndex("by_provider_normalized", (q) =>
          q.eq("provider", "instagram").eq("normalizedValue", LEGACY_HANDLE),
        )
        .take(MAX_IDENTITIES_PER_KIND + 1),
      loadVenueAuditRows(ctx, legacy._id),
      loadVenueAuditRows(ctx, canonical._id),
    ]);
    if (eventReferences.length > 0) issues.push("legacy_event_reference_present");
    if (sourceOccurrenceReferences.length > 0) {
      issues.push("legacy_source_occurrence_reference_present");
    }
    if (favoriteReferences.length > 0) {
      issues.push("legacy_favorite_venue_reference_present");
    }
    if (loadedLegacyIdentities.overBound) {
      issues.push("legacy_identity_set_over_bound");
    }
    if (loadedCanonicalIdentities.overBound) {
      issues.push("canonical_identity_set_over_bound");
    }
    if (providerAccountMatches.length > MAX_IDENTITIES_PER_KIND) {
      issues.push("legacy_provider_account_identity_set_over_bound");
    }
    if (loadedLegacyAuditRows.overBound || loadedCanonicalAuditRows.overBound) {
      issues.push("venue_audit_set_over_bound");
    }
    legacyIdentities = loadedLegacyIdentities.identities;
    legacyAuditRows = loadedLegacyAuditRows.rows;
    canonicalAuditRows = loadedCanonicalAuditRows.rows;

    const canonicalLegacyHandleIdentities =
      loadedCanonicalIdentities.identities.filter(
        (identity) =>
          identity.kind === "provider_account" &&
          identity.normalizedValue === LEGACY_HANDLE,
      );
    if (canonicalLegacyHandleIdentities.length > 1) {
      issues.push("canonical_legacy_provider_account_identity_not_unique");
    }
    canonicalLegacyHandleIdentity =
      canonicalLegacyHandleIdentities.length === 1
        ? canonicalLegacyHandleIdentities[0]
        : null;
    if (
      providerAccountMatches.some(
        (identity) =>
          identity.active &&
          identity.venueId !== legacy._id &&
          identity.venueId !== canonical._id,
      )
    ) {
      issues.push("legacy_provider_account_owned_by_unexpected_venue");
    }
    if (
      sourceDirectory
        .slice(0, MAX_INSTAGRAM_SOURCE_DIRECTORY)
        .some(
          (source) =>
            source.venueId === legacy._id && source._id !== legacySource?._id,
        )
    ) {
      issues.push("unexpected_instagram_source_reference_to_legacy_venue");
    }
  }

  const legacyAuditMatches = legacyAuditRows.filter(
    (row) => row.action === LEGACY_AUDIT_ACTION,
  );
  const canonicalAuditMatches = canonicalAuditRows.filter(
    (row) => row.action === CANONICAL_AUDIT_ACTION,
  );
  const preState = Boolean(
    canonical &&
      legacy &&
      legacySource &&
      isLegacyPreLifecycle(legacy) &&
      legacySource.venueId === legacy._id &&
      legacyAuditMatches.length === 0 &&
      canonicalAuditMatches.length === 0 &&
      (!canonicalLegacyHandleIdentity || !canonicalLegacyHandleIdentity.active),
  );
  const postState = Boolean(
    canonical &&
      legacy &&
      legacySource &&
      isLegacyPostLifecycle(legacy) &&
      legacySource.venueId === canonical._id &&
      legacyIdentities.every((identity) => !identity.active) &&
      canonicalLegacyHandleIdentity &&
      isExactCanonicalLegacyHandleIdentity(
        canonicalLegacyHandleIdentity,
        canonical._id,
      ) &&
      exactAuditRows({
        action: LEGACY_AUDIT_ACTION,
        afterJson: legacyAfterAuditJson(),
        beforeJson: [
          JSON.stringify({
            isActive: true,
            publicStatus: null,
            scrapeActive: null,
          }),
          JSON.stringify({
            isActive: true,
            publicStatus: "published",
            scrapeActive: true,
          }),
        ],
        rows: legacyAuditRows,
      }) &&
      exactAuditRows({
        action: CANONICAL_AUDIT_ACTION,
        afterJson: canonicalAfterAuditJson(canonical._id),
        beforeJson: JSON.stringify({
          instagramSourceHandle: LEGACY_HANDLE,
          instagramSourceVenueId: String(legacy._id),
        }),
        rows: canonicalAuditRows,
      }),
  );
  if (issues.length === 0 && !preState && !postState) {
    issues.push("kolarac_consolidation_partial_or_unknown_state");
  }
  issues.sort();
  return {
    canonical,
    canonicalAuditRows,
    canonicalLegacyHandleIdentity,
    canonicalSource,
    issues,
    legacy,
    legacyAuditRows,
    legacyIdentities,
    legacySource,
    state:
      issues.length > 0 ? "blocked" : postState ? "post_apply" : "pre_apply",
  };
}

/**
 * One reviewed, bounded venue-directory consolidation. It intentionally does
 * not merge arbitrary venue rows: only the exact Kolarac duplicate and its
 * exact active Instagram source may cross the canonical boundary.
 */
export async function consolidateReviewedKolaracVenueHandler(
  ctx: MutationCtx,
  args: EventDomainMigrationBatchArgs,
) {
  const dryRun = args.dryRun ?? true;
  const inspection = await inspectKolaracConsolidation(ctx);
  const counts: EventDomainMigrationBatchCounts = {
    errorCount: 0,
    mismatchCount: inspection.issues.length,
    scannedCount: 1,
    unchangedCount: inspection.state === "post_apply" ? 1 : 0,
    updatedCount: 0,
  };
  if (
    inspection.state === "pre_apply" &&
    inspection.canonical &&
    inspection.legacy &&
    inspection.legacySource
  ) {
    const existingCanonicalIdentity = inspection.canonicalLegacyHandleIdentity;
    counts.updatedCount =
      4 +
      inspection.legacyIdentities.filter((identity) => identity.active).length +
      (existingCanonicalIdentity &&
      isExactCanonicalLegacyHandleIdentity(
        existingCanonicalIdentity,
        inspection.canonical._id,
      )
        ? 0
        : 1);
    if (!dryRun) {
      const now = Date.now();
      const legacyLifecycleBefore = JSON.stringify({
        isActive: inspection.legacy.isActive ?? null,
        publicStatus: inspection.legacy.publicStatus ?? null,
        scrapeActive: inspection.legacy.scrapeActive ?? null,
      });
      await ctx.db.patch(inspection.legacy._id, {
        isActive: false,
        publicStatus: "hidden",
        scrapeActive: false,
        updatedAt: now,
      });
      await ctx.db.patch(inspection.legacySource._id, {
        updatedAt: now,
        venueId: inspection.canonical._id,
      });
      await deactivateVenueIdentities(ctx, inspection.legacy._id);
      await upsertClaim(
        ctx,
        inspection.canonical._id,
        {
          kind: "provider_account",
          normalizedValue: LEGACY_HANDLE,
          provider: "instagram",
          rawValue: LEGACY_HANDLE,
        },
        "manual",
      );
      await ctx.db.insert("venueAuditLog", {
        action: LEGACY_AUDIT_ACTION,
        actor: MIGRATION_ACTOR,
        afterJson: legacyAfterAuditJson(),
        beforeJson: legacyLifecycleBefore,
        createdAt: now,
        note: AUDIT_NOTE,
        venueId: inspection.legacy._id,
      });
      await ctx.db.insert("venueAuditLog", {
        action: CANONICAL_AUDIT_ACTION,
        actor: MIGRATION_ACTOR,
        afterJson: canonicalAfterAuditJson(inspection.canonical._id),
        beforeJson: JSON.stringify({
          instagramSourceHandle: LEGACY_HANDLE,
          instagramSourceVenueId: String(inspection.legacy._id),
        }),
        createdAt: now,
        note: AUDIT_NOTE,
        venueId: inspection.canonical._id,
      });
    }
  }
  await recordEventDomainMigrationProgress({
    counts,
    ctx,
    cursor: "",
    detailJson: JSON.stringify({
      issues: inspection.issues,
      state: inspection.state,
    }),
    dryRun,
    inputCursor: args.cursor ?? null,
    isDone: true,
    key: REVIEWED_KOLARAC_VENUE_CONSOLIDATION_KEY,
    phase: "reviewed_venue_consolidation",
    restart: args.restart ?? false,
  });
  return {
    ...counts,
    continueCursor: "",
    dryRun,
    isDone: true,
  };
}
