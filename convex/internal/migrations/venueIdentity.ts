import type { Doc } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { LEGACY_VENUE_ALIAS_SEEDS } from "../../../lib/config/legacy-venue-alias-seeds";
import { buildVenueIdentityClaims } from "../../../lib/domain/venues/venue-resolver";
import {
  normalizeHandle,
  normalizeVenueComparableText,
} from "../../../lib/pipeline/venue-normalization";
import {
  assertCleanCompletedEventDomainMigration,
  normalizeEventDomainMigrationBatchSize,
  recordEventDomainMigrationProgress,
  type EventDomainMigrationBatchArgs,
  type EventDomainMigrationBatchCounts,
} from "./eventDomainShared";

const MAX_IDENTITIES_PER_KIND = 50;

export const VENUE_COMPATIBILITY_SEED_AUDIT_KEY =
  "venue-compatibility-seed-audit-v1";

type VenueCompatibilitySeedAuditIssue = {
  canonicalHandle: string;
  candidateVenueIds: string[];
  reason: "ambiguous_target" | "duplicate_alias_claim" | "missing_target";
  value?: string;
};

async function loadVenueCandidatesForCompatibilitySeed(
  ctx: MutationCtx,
  canonicalHandle: string,
): Promise<Doc<"venues">[]> {
  const normalizedHandle = normalizeHandle(canonicalHandle);
  const batches = await Promise.all([
    ctx.db
      .query("venues")
      .withIndex("by_normalizedInstagramHandle", (q) =>
        q.eq("normalizedInstagramHandle", normalizedHandle),
      )
      .take(3),
    ctx.db
      .query("venues")
      .withIndex("by_instagramHandle", (q) =>
        q.eq("instagramHandle", normalizedHandle),
      )
      .take(3),
    ctx.db
      .query("venues")
      .withIndex("by_instagramHandle", (q) =>
        q.eq("instagramHandle", `@${normalizedHandle}`),
      )
      .take(3),
  ]);
  return [
    ...new Map(
      batches
        .flat()
        .filter(
          (venue) =>
            normalizeHandle(venue.instagramHandle) === normalizedHandle,
        )
        .map((venue) => [String(venue._id), venue]),
    ).values(),
  ];
}

/**
 * Proves every migration-only venue alias seed has exactly one durable venue
 * target before the seed-backed identity backfill may run. The fixed seed set
 * is deliberately small and fully bounded; missing or ambiguous targets stay
 * explicit in the durable audit state instead of disappearing while a
 * venue-centric paginator runs.
 */
export async function auditVenueCompatibilitySeedsHandler(
  ctx: MutationCtx,
  args: { dryRun?: boolean; restart?: boolean },
) {
  const dryRun = args.dryRun ?? true;
  const issues: VenueCompatibilitySeedAuditIssue[] = [];
  const aliasOwners = new Map<string, Set<string>>();
  for (const seed of LEGACY_VENUE_ALIAS_SEEDS) {
    const canonicalHandle = normalizeHandle(seed.canonicalHandle);
    const candidates = await loadVenueCandidatesForCompatibilitySeed(
      ctx,
      canonicalHandle,
    );
    if (candidates.length === 0) {
      issues.push({
        candidateVenueIds: [],
        canonicalHandle,
        reason: "missing_target",
      });
    } else if (candidates.length !== 1) {
      issues.push({
        candidateVenueIds: candidates.map((venue) => String(venue._id)).sort(),
        canonicalHandle,
        reason: "ambiguous_target",
      });
    }
    for (const alias of seed.aliases) {
      const normalizedAlias = normalizeVenueComparableText(alias);
      if (!normalizedAlias) continue;
      const owners = aliasOwners.get(normalizedAlias) ?? new Set<string>();
      owners.add(canonicalHandle);
      aliasOwners.set(normalizedAlias, owners);
    }
  }
  for (const [value, owners] of aliasOwners) {
    if (owners.size <= 1) continue;
    for (const canonicalHandle of [...owners].sort()) {
      issues.push({
        candidateVenueIds: [],
        canonicalHandle,
        reason: "duplicate_alias_claim",
        value,
      });
    }
  }
  issues.sort((left, right) =>
    `${left.reason}:${left.canonicalHandle}:${left.value ?? ""}`.localeCompare(
      `${right.reason}:${right.canonicalHandle}:${right.value ?? ""}`,
    ),
  );
  const issuesJson = JSON.stringify(issues);
  if (!dryRun) {
    const existing = await ctx.db
      .query("eventDomainMigrationState")
      .withIndex("by_key", (q) =>
        q.eq("key", VENUE_COMPATIBILITY_SEED_AUDIT_KEY),
      )
      .unique();
    const stableCompletedRerun =
      !args.restart &&
      issues.length === 0 &&
      existing?.completedAt !== undefined &&
      existing.mismatchCount === 0 &&
      (existing.errorCount ?? 0) === 0;
    if (!stableCompletedRerun) {
      await recordEventDomainMigrationProgress({
        counts: {
          mismatchCount: issues.length,
          scannedCount: LEGACY_VENUE_ALIAS_SEEDS.length,
          updatedCount: 0,
        },
        ctx,
        cursor: String(LEGACY_VENUE_ALIAS_SEEDS.length),
        detailJson: issuesJson,
        dryRun,
        inputCursor: null,
        isDone: true,
        key: VENUE_COMPATIBILITY_SEED_AUDIT_KEY,
        phase: "compatibility_seed_target_audit",
        restart: args.restart ?? false,
      });
    }
  }
  return {
    dryRun,
    issueCount: issues.length,
    issuesJson,
    scannedCount: LEGACY_VENUE_ALIAS_SEEDS.length,
  };
}

/** Converts existing venue names/aliases/accounts into indexed identity data. */
export async function backfillVenueIdentitiesBatchHandler(
  ctx: MutationCtx,
  args: EventDomainMigrationBatchArgs,
) {
  await assertCleanCompletedEventDomainMigration(
    ctx,
    VENUE_COMPATIBILITY_SEED_AUDIT_KEY,
  );
  const dryRun = args.dryRun ?? true;
  const page = await ctx.db
    .query("venues")
    .order("asc")
    .paginate({
      cursor: args.cursor ?? null,
      numItems: normalizeEventDomainMigrationBatchSize(args.limit),
    });
  const counts: EventDomainMigrationBatchCounts = {
    mismatchCount: 0,
    scannedCount: page.page.length,
    updatedCount: 0,
  };
  for (const venue of page.page) {
    let venueUnsafe = false;
    const byKind = new Map<
      Doc<"venueIdentities">["kind"],
      Doc<"venueIdentities">[]
    >();
    for (const kind of [
      "canonical_name",
      "alias",
      "historical_alias",
      "provider_account",
    ] as const) {
      const existing = await ctx.db
        .query("venueIdentities")
        .withIndex("by_venue_kind", (q) =>
          q.eq("venueId", venue._id).eq("kind", kind),
        )
        .take(MAX_IDENTITIES_PER_KIND + 1);
      if (existing.length > MAX_IDENTITIES_PER_KIND) {
        counts.mismatchCount += 1;
        venueUnsafe = true;
        break;
      }
      byKind.set(kind, existing);
    }
    if (venueUnsafe) continue;
    const venueRecordClaims = buildVenueIdentityClaims(venue);
    const venueRecordClaimKeys = new Set(
      venueRecordClaims.map(
        (claim) => `${claim.kind}:${claim.normalizedValue}`,
      ),
    );
    const normalizedVenueHandle = normalizeHandle(venue.instagramHandle ?? "");
    const compatibilityClaims = LEGACY_VENUE_ALIAS_SEEDS.filter(
      (seed) => normalizeHandle(seed.canonicalHandle) === normalizedVenueHandle,
    ).flatMap((seed) =>
      seed.aliases.flatMap((alias) => {
        const normalizedValue = normalizeVenueComparableText(alias);
        return normalizedValue
          ? [
              {
                kind: "alias" as const,
                normalizedValue,
                provider: undefined,
                rawValue: alias,
              },
            ]
          : [];
      }),
    );
    const desiredClaims = [
      ...new Map(
        [...venueRecordClaims, ...compatibilityClaims].map((claim) => [
          `${claim.kind}:${claim.normalizedValue}`,
          claim,
        ]),
      ).values(),
    ];
    const compatibilityClaimKeys = new Set(
      compatibilityClaims.map(
        (claim) => `${claim.kind}:${claim.normalizedValue}`,
      ),
    );
    // Compute the final per-kind cardinality against the unchanged snapshot
    // before any insert or migration-source promotion is written.
    for (const kind of [
      "canonical_name",
      "alias",
      "historical_alias",
      "provider_account",
    ] as const) {
      const existing = byKind.get(kind) ?? [];
      const existingValues = new Set(
        existing.map((identity) => identity.normalizedValue),
      );
      const desiredForKind = desiredClaims.filter(
        (claim) => claim.kind === kind,
      );
      const missingDesiredCount = desiredForKind.filter(
        (claim) => !existingValues.has(claim.normalizedValue),
      ).length;
      if (
        desiredForKind.length > MAX_IDENTITIES_PER_KIND ||
        existing.length + missingDesiredCount > MAX_IDENTITIES_PER_KIND
      ) {
        counts.mismatchCount += 1;
        venueUnsafe = true;
        break;
      }
    }
    if (venueUnsafe) continue;
    // Reviewed compatibility aliases become durable manual identity data.
    // Refuse a seed whose normalized name is actively owned by another venue,
    // regardless of which name-identity kind owns it.
    for (const compatibilityClaim of compatibilityClaims) {
      const ownershipBatches = await Promise.all(
        (["canonical_name", "alias", "historical_alias"] as const).map((kind) =>
          ctx.db
            .query("venueIdentities")
            .withIndex("by_kind_normalized", (q) =>
              q
                .eq("kind", kind)
                .eq("normalizedValue", compatibilityClaim.normalizedValue),
            )
            .take(MAX_IDENTITIES_PER_KIND + 1),
        ),
      );
      if (
        ownershipBatches.some(
          (batch) => batch.length > MAX_IDENTITIES_PER_KIND,
        ) ||
        ownershipBatches
          .flat()
          .some((identity) => identity.active && identity.venueId !== venue._id)
      ) {
        counts.mismatchCount += 1;
        venueUnsafe = true;
        break;
      }
    }
    if (venueUnsafe) continue;
    for (const desired of desiredClaims) {
      if (desired.kind !== "provider_account") continue;
      const conflicts = await ctx.db
        .query("venueIdentities")
        .withIndex("by_provider_normalized", (q) =>
          q
            .eq("provider", "instagram")
            .eq("normalizedValue", desired.normalizedValue),
        )
        .take(MAX_IDENTITIES_PER_KIND + 1);
      if (
        conflicts.length > MAX_IDENTITIES_PER_KIND ||
        conflicts.some(
          (identity) => identity.venueId !== venue._id && identity.active,
        )
      ) {
        counts.mismatchCount += 1;
        venueUnsafe = true;
        break;
      }
    }
    if (venueUnsafe) continue;
    for (const desired of desiredClaims) {
      const existing = byKind
        .get(desired.kind)
        ?.find(
          (identity) => identity.normalizedValue === desired.normalizedValue,
        );
      if (existing) {
        if (!existing.active) {
          counts.mismatchCount += 1;
        } else {
          const desiredKey = `${desired.kind}:${desired.normalizedValue}`;
          const nextSource = venueRecordClaimKeys.has(desiredKey)
            ? existing.source === "migration"
              ? "venue_record"
              : existing.source
            : compatibilityClaimKeys.has(desiredKey) &&
                ["migration", "observed_source"].includes(existing.source)
              ? "manual"
              : existing.source;
          if (nextSource !== existing.source) {
            counts.updatedCount += 1;
            if (!dryRun) {
              await ctx.db.patch(existing._id, {
                source: nextSource,
                updatedAt: Date.now(),
              });
            }
          }
        }
        continue;
      }
      counts.updatedCount += 1;
      if (!dryRun) {
        const now = Date.now();
        await ctx.db.insert("venueIdentities", {
          active: true,
          createdAt: now,
          kind: desired.kind,
          ...(desired.provider ? { provider: desired.provider } : {}),
          rawValue: desired.rawValue,
          normalizedValue: desired.normalizedValue,
          source: venueRecordClaimKeys.has(
            `${desired.kind}:${desired.normalizedValue}`,
          )
            ? "venue_record"
            : compatibilityClaimKeys.has(
                  `${desired.kind}:${desired.normalizedValue}`,
                )
              ? "manual"
              : "migration",
          updatedAt: now,
          venueId: venue._id,
        });
      }
    }
  }
  await recordEventDomainMigrationProgress({
    counts,
    ctx,
    cursor: page.continueCursor,
    dryRun,
    inputCursor: args.cursor ?? null,
    isDone: page.isDone,
    key: "venue-identities-v1",
    phase: "venue_identities",
    restart: args.restart ?? false,
  });
  return {
    ...counts,
    continueCursor: page.continueCursor,
    dryRun,
    isDone: page.isDone,
  };
}
