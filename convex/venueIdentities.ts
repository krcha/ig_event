import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { DomainError } from "../lib/domain/errors";
import {
  buildVenueIdentityClaims,
  type VenueIdentityClaim,
} from "../lib/domain/venues/venue-resolver";
import {
  normalizeHandle,
  normalizeVenueComparableText,
} from "../lib/pipeline/venue-normalization";
import { requireAdminOrServiceSecret } from "./authz";

const MAX_IDENTITIES_PER_VENUE_KIND = 50;

const identityKind = v.union(
  v.literal("canonical_name"),
  v.literal("alias"),
  v.literal("historical_alias"),
  v.literal("provider_account"),
);
const identitySource = v.union(
  v.literal("venue_record"),
  v.literal("manual"),
  v.literal("migration"),
  v.literal("observed_source"),
);
const venueIdentityDocument = v.object({
  _creationTime: v.number(),
  _id: v.id("venueIdentities"),
  active: v.boolean(),
  createdAt: v.number(),
  kind: identityKind,
  normalizedValue: v.string(),
  provider: v.optional(v.literal("instagram")),
  rawValue: v.string(),
  source: identitySource,
  updatedAt: v.number(),
  venueId: v.id("venues"),
});

function dedupeAndValidateDesiredClaims(
  claims: readonly VenueIdentityClaim[],
): VenueIdentityClaim[] {
  const unique = [
    ...new Map(
      claims.map((claim) => [
        `${claim.kind}:${claim.normalizedValue}`,
        claim,
      ]),
    ).values(),
  ];
  for (const kind of [
    "canonical_name",
    "alias",
    "historical_alias",
    "provider_account",
  ] as const) {
    if (unique.filter((claim) => claim.kind === kind).length > MAX_IDENTITIES_PER_VENUE_KIND) {
      throw new DomainError(
        "RECONCILIATION_CONFLICT",
        `Venue ${kind} identity claims exceed the safe bounded limit.`,
      );
    }
  }
  return unique;
}

function normalizeIdentityValue(
  kind: Doc<"venueIdentities">["kind"],
  value: string,
): string {
  return kind === "provider_account"
    ? normalizeHandle(value)
    : normalizeVenueComparableText(value);
}

async function assertProviderAccountAvailable(
  ctx: MutationCtx,
  venueId: Id<"venues">,
  normalizedValue: string,
): Promise<void> {
  const matches = await ctx.db
    .query("venueIdentities")
    .withIndex("by_provider_normalized", (q) =>
      q.eq("provider", "instagram").eq("normalizedValue", normalizedValue),
    )
    .take(MAX_IDENTITIES_PER_VENUE_KIND + 1);
  if (matches.length > MAX_IDENTITIES_PER_VENUE_KIND) {
    throw new DomainError(
      "RECONCILIATION_CONFLICT",
      "Provider-account identity set exceeds the safe bounded limit.",
    );
  }
  if (matches.some((identity) => identity.active && identity.venueId !== venueId)) {
    throw new DomainError(
      "VENUE_AMBIGUOUS",
      "Instagram account identity is already assigned to another venue.",
      { details: { normalizedValue, venueId } },
    );
  }
}

export async function upsertClaim(
  ctx: MutationCtx,
  venueId: Id<"venues">,
  claim: VenueIdentityClaim,
  source: Doc<"venueIdentities">["source"],
): Promise<Id<"venueIdentities">> {
  if (claim.kind === "provider_account") {
    await assertProviderAccountAvailable(ctx, venueId, claim.normalizedValue);
  }
  const rows = await ctx.db
    .query("venueIdentities")
    .withIndex("by_venue_kind", (q) =>
      q.eq("venueId", venueId).eq("kind", claim.kind),
    )
    .take(MAX_IDENTITIES_PER_VENUE_KIND + 1);
  if (rows.length > MAX_IDENTITIES_PER_VENUE_KIND) {
    throw new DomainError(
      "RECONCILIATION_CONFLICT",
      "Venue identity set exceeds the safe bounded limit.",
    );
  }
  const existing = rows.find(
    (identity) => identity.normalizedValue === claim.normalizedValue,
  );
  const now = Date.now();
  if (existing) {
    const nextSource =
      source === "manual"
        ? "manual"
        : source === "venue_record" && existing.source === "migration"
          ? "venue_record"
          : existing.source;
    if (
      !existing.active ||
      existing.rawValue !== claim.rawValue ||
      existing.provider !== claim.provider ||
      existing.source !== nextSource
    ) {
      await ctx.db.patch(existing._id, {
        active: true,
        ...(claim.provider ? { provider: claim.provider } : { provider: undefined }),
        rawValue: claim.rawValue,
        source: nextSource,
        updatedAt: now,
      });
    }
    return existing._id;
  }
  if (rows.length >= MAX_IDENTITIES_PER_VENUE_KIND) {
    throw new DomainError(
      "RECONCILIATION_CONFLICT",
      "Venue identity set has reached the safe bounded limit.",
    );
  }
  return ctx.db.insert("venueIdentities", {
    active: true,
    createdAt: now,
    kind: claim.kind,
    ...(claim.provider ? { provider: claim.provider } : {}),
    normalizedValue: claim.normalizedValue,
    rawValue: claim.rawValue,
    source,
    updatedAt: now,
    venueId,
  });
}

/** Keeps ordinary venue record identities synchronized in the same mutation. */
export async function syncVenueRecordIdentities(
  ctx: MutationCtx,
  venue: Doc<"venues">,
): Promise<void> {
  // Venue aliases are normalized/deduplicated before any write, and the final
  // desired set is rejected atomically rather than partially truncated.
  const desired = dedupeAndValidateDesiredClaims(buildVenueIdentityClaims(venue));
  const desiredKeys = new Set(
    desired.map((claim) => `${claim.kind}:${claim.normalizedValue}`),
  );
  const kinds = [
    "canonical_name",
    "alias",
    "historical_alias",
    "provider_account",
  ] as const;
  const existingByKind = new Map<
    Doc<"venueIdentities">["kind"],
    Doc<"venueIdentities">[]
  >();
  for (const kind of kinds) {
    const existing = await ctx.db
      .query("venueIdentities")
      .withIndex("by_venue_kind", (q) =>
        q.eq("venueId", venue._id).eq("kind", kind),
      )
      .take(MAX_IDENTITIES_PER_VENUE_KIND + 1);
    if (existing.length > MAX_IDENTITIES_PER_VENUE_KIND) {
      throw new DomainError(
        "RECONCILIATION_CONFLICT",
        "Venue identity set exceeds the safe bounded limit.",
      );
    }
    existingByKind.set(kind, existing);
  }
  const retiringCanonicalNames = (existingByKind.get("canonical_name") ?? []).filter(
    (identity) =>
      ["venue_record", "migration"].includes(identity.source) &&
      identity.active &&
      !desiredKeys.has(`${identity.kind}:${identity.normalizedValue}`),
  );
  const historicalValues = new Set(
    (existingByKind.get("historical_alias") ?? []).map(
      (identity) => identity.normalizedValue,
    ),
  );
  const missingHistoricalValues = new Set(
    retiringCanonicalNames
      .map((identity) => identity.normalizedValue)
      .filter((value) => !historicalValues.has(value)),
  );
  for (const kind of kinds) {
    const existing = existingByKind.get(kind) ?? [];
    const existingValues = new Set(
      existing.map((identity) => identity.normalizedValue),
    );
    const missingDesiredCount = desired.filter(
      (claim) =>
        claim.kind === kind && !existingValues.has(claim.normalizedValue),
    ).length;
    const historicalAdditionCount =
      kind === "historical_alias" ? missingHistoricalValues.size : 0;
    if (
      existing.length + missingDesiredCount + historicalAdditionCount >
      MAX_IDENTITIES_PER_VENUE_KIND
    ) {
      throw new DomainError(
        "RECONCILIATION_CONFLICT",
        `Venue ${kind} identity set would exceed the safe bounded limit.`,
      );
    }
  }
  for (const claim of desired) {
    await upsertClaim(ctx, venue._id, claim, "venue_record");
  }

  for (const kind of ["canonical_name", "alias", "provider_account"] as const) {
    const existing = existingByKind.get(kind) ?? [];
    for (const identity of existing) {
      if (
        !["venue_record", "migration"].includes(identity.source) ||
        !identity.active ||
        desiredKeys.has(`${identity.kind}:${identity.normalizedValue}`)
      ) {
        continue;
      }
      if (identity.kind === "canonical_name") {
        if (!historicalValues.has(identity.normalizedValue)) {
          await ctx.db.insert("venueIdentities", {
            active: true,
            createdAt: Date.now(),
            kind: "historical_alias",
            normalizedValue: identity.normalizedValue,
            rawValue: identity.rawValue,
            source: "observed_source",
            updatedAt: Date.now(),
            venueId: venue._id,
          });
          historicalValues.add(identity.normalizedValue);
        }
      }
      await ctx.db.patch(identity._id, { active: false, updatedAt: Date.now() });
    }
  }
}

/** Deactivates every identity while retaining historical ownership/audit data. */
export async function deactivateVenueIdentities(
  ctx: MutationCtx,
  venueId: Id<"venues">,
): Promise<void> {
  for (const kind of [
    "canonical_name",
    "alias",
    "historical_alias",
    "provider_account",
  ] as const) {
    const identities = await ctx.db
      .query("venueIdentities")
      .withIndex("by_venue_kind", (q) => q.eq("venueId", venueId).eq("kind", kind))
      .take(MAX_IDENTITIES_PER_VENUE_KIND + 1);
    if (identities.length > MAX_IDENTITIES_PER_VENUE_KIND) {
      throw new DomainError(
        "RECONCILIATION_CONFLICT",
        "Venue identity set exceeds the safe bounded limit.",
      );
    }
    for (const identity of identities) {
      if (identity.active) {
        await ctx.db.patch(identity._id, { active: false, updatedAt: Date.now() });
      }
    }
  }
}

export const listByVenue = query({
  args: {
    serviceSecret: v.optional(v.string()),
    venueId: v.id("venues"),
  },
  returns: v.array(venueIdentityDocument),
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const batches = await Promise.all(
      ["canonical_name", "alias", "historical_alias", "provider_account"].map(
        (kind) =>
          ctx.db
            .query("venueIdentities")
            .withIndex("by_venue_kind", (q) =>
              q.eq("venueId", args.venueId).eq("kind", kind as Doc<"venueIdentities">["kind"]),
            )
            .take(MAX_IDENTITIES_PER_VENUE_KIND + 1),
      ),
    );
    if (batches.some((batch) => batch.length > MAX_IDENTITIES_PER_VENUE_KIND)) {
      throw new Error("Venue identity set exceeds the safe bounded limit.");
    }
    return batches.flat().sort((left, right) => left.createdAt - right.createdAt);
  },
});

export const upsertIdentity = mutation({
  args: {
    kind: identityKind,
    provider: v.optional(v.literal("instagram")),
    rawValue: v.string(),
    serviceSecret: v.optional(v.string()),
    venueId: v.id("venues"),
  },
  returns: v.id("venueIdentities"),
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const venue = await ctx.db.get(args.venueId);
    if (!venue) throw new DomainError("VENUE_UNKNOWN", "Venue not found.");
    const rawValue = args.rawValue.trim();
    const normalizedValue = normalizeIdentityValue(args.kind, rawValue);
    if (!rawValue || !normalizedValue) {
      throw new DomainError("VENUE_UNKNOWN", "Venue identity value is empty.");
    }
    if (args.kind === "canonical_name") {
      throw new DomainError(
        "RECONCILIATION_CONFLICT",
        "Canonical venue names are managed by the venue record; update the venue instead.",
      );
    }
    return upsertClaim(
      ctx,
      args.venueId,
      {
        kind: args.kind,
        normalizedValue,
        ...(args.kind === "provider_account"
          ? { provider: args.provider ?? "instagram" }
          : {}),
        rawValue,
      },
      "manual",
    );
  },
});

export const setIdentityActive = mutation({
  args: {
    active: v.boolean(),
    id: v.id("venueIdentities"),
    serviceSecret: v.optional(v.string()),
  },
  returns: v.id("venueIdentities"),
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const identity = await ctx.db.get(args.id);
    if (!identity) throw new DomainError("VENUE_UNKNOWN", "Venue identity not found.");
    if (identity.source === "venue_record") {
      throw new DomainError(
        "RECONCILIATION_CONFLICT",
        "Venue-record identities are managed by venue synchronization and cannot be toggled directly.",
      );
    }
    if (args.active && identity.kind === "provider_account") {
      await assertProviderAccountAvailable(
        ctx,
        identity.venueId,
        identity.normalizedValue,
      );
    }
    await ctx.db.patch(identity._id, { active: args.active, updatedAt: Date.now() });
    return identity._id;
  },
});
