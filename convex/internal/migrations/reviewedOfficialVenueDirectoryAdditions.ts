import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import {
  buildVenueIdentityClaims,
  type VenueIdentityClaim,
} from "../../../lib/domain/venues/venue-resolver";
import {
  normalizeHandle,
  normalizeVenueComparableText,
} from "../../../lib/pipeline/venue-normalization";
import { upsertClaim } from "../../venueIdentities";
import {
  recordEventDomainMigrationProgress,
  type EventDomainMigrationBatchArgs,
  type EventDomainMigrationBatchCounts,
} from "./eventDomainShared";

export const REVIEWED_OFFICIAL_VENUE_DIRECTORY_ADDITIONS_KEY =
  "reviewed-official-venue-directory-additions-v1";

const MIGRATION_ACTOR = REVIEWED_OFFICIAL_VENUE_DIRECTORY_ADDITIONS_KEY;
const AUDIT_ACTION = "reviewed_official_venue_directory_added";
const AUDIT_NOTE =
  "Human-reviewed official venue directory addition. This does not enroll an Instagram ingestion source.";
const MAX_VENUE_DIRECTORY = 2_000;
const MAX_HANDLE_CANDIDATES = 2;
const MAX_IDENTITIES_PER_CLAIM = 50;
const MAX_IDENTITIES_PER_VENUE_KIND = 50;
const MAX_AUDIT_ROWS_PER_VENUE = 100;

type ReviewedVenueSpec = {
  aliases: readonly string[];
  instagramHandle: string;
  location: string;
  name: string;
};

export const REVIEWED_OFFICIAL_VENUE_DIRECTORY_ADDITIONS = [
  {
    aliases: [
      "Vinarija Zvonko Bogdan Palić",
      "Vinarije Zvonko Bogdan",
      "Vinariji Zvonko Bogdan",
    ],
    instagramHandle: "vinarijazvonkobogdan",
    location: "Kanjiški put 45, Palić",
    name: "Vinarija Zvonko Bogdan",
  },
  {
    aliases: [
      "Botanical Garden Jevremovac",
      "Jevremovac Botanical Garden",
      "Botaničkoj bašti Jevremovac",
      "Jevremovac",
    ],
    instagramHandle: "belgrade_botanical_garden",
    location: "Takovska 43, Beograd",
    name: "Botanička bašta Jevremovac",
  },
] as const satisfies readonly ReviewedVenueSpec[];

type ReviewedVenue = Doc<"venues">;
type ReviewedVenueIdentity = Doc<"venueIdentities">;

type SpecInspection = {
  claims: VenueIdentityClaim[];
  issues: string[];
  spec: ReviewedVenueSpec;
  state: "blocked" | "post_apply" | "pre_apply";
};

type Inspection = {
  issues: string[];
  specs: SpecInspection[];
  state: "blocked" | "post_apply" | "pre_apply";
};

function stableUniqueById<T extends { _id: unknown }>(rows: readonly T[]): T[] {
  return [...new Map(rows.map((row) => [String(row._id), row])).values()];
}

function expectedVenueRecord(spec: ReviewedVenueSpec) {
  const handle = normalizeHandle(spec.instagramHandle);
  return {
    aliases: [...spec.aliases],
    category: "venue" as const,
    instagramHandle: handle,
    location: spec.location,
    name: spec.name,
    normalizedInstagramHandle: handle,
    publicStatus: "published" as const,
    scrapeActive: false,
  };
}

function expectedClaims(spec: ReviewedVenueSpec): VenueIdentityClaim[] {
  return buildVenueIdentityClaims(expectedVenueRecord(spec));
}

function exactVenueRecord(
  venue: ReviewedVenue,
  spec: ReviewedVenueSpec,
): boolean {
  const expected = expectedVenueRecord(spec);
  return (
    venue.name === expected.name &&
    venue.category === expected.category &&
    venue.instagramHandle === expected.instagramHandle &&
    venue.normalizedInstagramHandle === expected.normalizedInstagramHandle &&
    venue.location === expected.location &&
    venue.publicStatus === expected.publicStatus &&
    venue.scrapeActive === expected.scrapeActive &&
    JSON.stringify(venue.aliases ?? []) === JSON.stringify(expected.aliases)
  );
}

function exactIdentity(
  identity: ReviewedVenueIdentity,
  venueId: Id<"venues">,
  claim: VenueIdentityClaim,
): boolean {
  return (
    identity.venueId === venueId &&
    identity.kind === claim.kind &&
    identity.provider === claim.provider &&
    identity.rawValue === claim.rawValue &&
    identity.normalizedValue === claim.normalizedValue &&
    identity.active === true &&
    identity.source === "venue_record"
  );
}

function beforeAuditJson(): string {
  return JSON.stringify({ present: false });
}

function afterAuditJson(
  venueId: Id<"venues">,
  spec: ReviewedVenueSpec,
  claims: readonly VenueIdentityClaim[],
): string {
  return JSON.stringify({
    identities: claims.map((claim) => ({
      active: true,
      kind: claim.kind,
      normalizedValue: claim.normalizedValue,
      ...(claim.provider ? { provider: claim.provider } : {}),
      rawValue: claim.rawValue,
      source: "venue_record",
    })),
    venue: {
      ...expectedVenueRecord(spec),
      venueId: String(venueId),
    },
  });
}

async function loadVenueCandidates(
  ctx: MutationCtx,
  handle: string,
): Promise<ReviewedVenue[]> {
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

async function loadClaimIdentities(
  ctx: MutationCtx,
  claim: VenueIdentityClaim,
): Promise<ReviewedVenueIdentity[]> {
  // The runtime resolver interprets every raw claim both as venue text and as
  // a possible Instagram handle. Mirror that cross-family lookup here so an
  // orphan/manual provider identity cannot become ambiguous with a new name
  // alias (or vice versa) after this migration commits.
  const normalizedName = normalizeVenueComparableText(claim.rawValue);
  const normalizedProvider = normalizeHandle(claim.rawValue);
  const batches = await Promise.all([
    ...(["canonical_name", "alias", "historical_alias"] as const).map((kind) =>
      normalizedName
        ? ctx.db
            .query("venueIdentities")
            .withIndex("by_kind_normalized", (q) =>
              q.eq("kind", kind).eq("normalizedValue", normalizedName),
            )
            .take(MAX_IDENTITIES_PER_CLAIM + 1)
        : Promise.resolve([] as ReviewedVenueIdentity[]),
    ),
    normalizedProvider
      ? ctx.db
          .query("venueIdentities")
          .withIndex("by_provider_normalized", (q) =>
            q
              .eq("provider", "instagram")
              .eq("normalizedValue", normalizedProvider),
          )
          .take(MAX_IDENTITIES_PER_CLAIM + 1)
      : Promise.resolve([] as ReviewedVenueIdentity[]),
  ]);
  return stableUniqueById(batches.flat());
}

async function loadVenueIdentities(
  ctx: MutationCtx,
  venueId: Id<"venues">,
): Promise<{ identities: ReviewedVenueIdentity[]; overBound: boolean }> {
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
        .take(MAX_IDENTITIES_PER_VENUE_KIND + 1),
    ),
  );
  return {
    identities: batches.flat(),
    overBound: batches.some(
      (batch) => batch.length > MAX_IDENTITIES_PER_VENUE_KIND,
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

function comparableVenueValues(venue: ReviewedVenue): Set<string> {
  return new Set(
    [venue.name, ...(venue.aliases ?? [])]
      .map((value) => normalizeVenueComparableText(value))
      .filter(Boolean),
  );
}

function exactAuditRows(
  rows: readonly Doc<"venueAuditLog">[],
  venueId: Id<"venues">,
  spec: ReviewedVenueSpec,
  claims: readonly VenueIdentityClaim[],
): boolean {
  const matches = rows.filter((row) => row.action === AUDIT_ACTION);
  return (
    matches.length === 1 &&
    matches[0].actor === MIGRATION_ACTOR &&
    matches[0].note === AUDIT_NOTE &&
    matches[0].beforeJson === beforeAuditJson() &&
    matches[0].afterJson === afterAuditJson(venueId, spec, claims)
  );
}

async function inspectReviewedOfficialVenueDirectoryAdditions(
  ctx: MutationCtx,
): Promise<Inspection> {
  const venueDirectory = await ctx.db
    .query("venues")
    .take(MAX_VENUE_DIRECTORY + 1);
  const directoryOverBound = venueDirectory.length > MAX_VENUE_DIRECTORY;
  const boundedDirectory = venueDirectory.slice(0, MAX_VENUE_DIRECTORY);
  const inspections: SpecInspection[] = [];

  for (const spec of REVIEWED_OFFICIAL_VENUE_DIRECTORY_ADDITIONS) {
    const claims = expectedClaims(spec);
    const issues: string[] = [];
    if (directoryOverBound) issues.push("venue_directory_over_bound");
    const candidates = await loadVenueCandidates(ctx, spec.instagramHandle);
    if (candidates.length > 1) issues.push("venue_handle_not_unique");
    const venue = candidates.length === 1 ? candidates[0] : null;
    if (venue && !exactVenueRecord(venue, spec)) {
      issues.push("venue_shape_drifted");
    }

    const expectedComparableValues = new Set(
      [spec.name, ...spec.aliases]
        .map((value) => normalizeVenueComparableText(value))
        .filter(Boolean),
    );
    const conflictingDirectoryRows = boundedDirectory.filter(
      (candidate) =>
        candidate._id !== venue?._id &&
        [...comparableVenueValues(candidate)].some((value) =>
          expectedComparableValues.has(value),
        ),
    );
    if (conflictingDirectoryRows.length > 0) {
      issues.push("venue_name_or_alias_owned_by_unexpected_venue");
    }

    const claimIdentityBatches = await Promise.all(
      claims.map((claim) => loadClaimIdentities(ctx, claim)),
    );
    if (
      claimIdentityBatches.some(
        (identities) => identities.length > MAX_IDENTITIES_PER_CLAIM,
      )
    ) {
      issues.push("identity_claim_set_over_bound");
    }
    const conflictingClaimIdentity = claimIdentityBatches.some((identities) =>
      identities.some((identity) => identity.venueId !== venue?._id),
    );
    if (conflictingClaimIdentity) {
      issues.push("identity_claim_owned_by_unexpected_venue");
    }

    let auditRows: Doc<"venueAuditLog">[] = [];
    let postState = false;
    if (venue) {
      const [loadedVenueIdentities, loadedAuditRows] = await Promise.all([
        loadVenueIdentities(ctx, venue._id),
        loadVenueAuditRows(ctx, venue._id),
      ]);
      if (loadedVenueIdentities.overBound) {
        issues.push("venue_identity_set_over_bound");
      }
      if (loadedAuditRows.overBound) issues.push("venue_audit_set_over_bound");
      auditRows = loadedAuditRows.rows;
      const expectedIdentityKeys = new Set(
        claims.map((claim) => `${claim.kind}:${claim.normalizedValue}`),
      );
      const exactIdentitySet =
        loadedVenueIdentities.identities.length === claims.length &&
        claims.every((claim) =>
          loadedVenueIdentities.identities.some((identity) =>
            exactIdentity(identity, venue._id, claim),
          ),
        ) &&
        loadedVenueIdentities.identities.every((identity) =>
          expectedIdentityKeys.has(
            `${identity.kind}:${identity.normalizedValue}`,
          ),
        );
      postState =
        exactVenueRecord(venue, spec) &&
        exactIdentitySet &&
        exactAuditRows(auditRows, venue._id, spec, claims);
      if (issues.length === 0 && !postState) {
        issues.push("venue_addition_partial_or_unknown_state");
      }
    }

    const preState = Boolean(
      !venue &&
      claimIdentityBatches.every((identities) => identities.length === 0) &&
      issues.length === 0,
    );
    issues.sort();
    inspections.push({
      claims,
      issues,
      spec,
      state:
        issues.length > 0 ? "blocked" : postState ? "post_apply" : "pre_apply",
    });
    if (!preState && !postState && issues.length === 0) {
      throw new Error("Reviewed venue inspection entered an impossible state.");
    }
  }

  const states = new Set(inspections.map((inspection) => inspection.state));
  const issues = inspections.flatMap((inspection) =>
    inspection.issues.map(
      (issue) => `${inspection.spec.instagramHandle}:${issue}`,
    ),
  );
  if (states.size > 1 && !states.has("blocked")) {
    issues.push("directory_additions_mixed_pre_and_post_state");
  }
  issues.sort();
  return {
    issues,
    specs: inspections,
    state:
      issues.length > 0
        ? "blocked"
        : inspections.every((inspection) => inspection.state === "post_apply")
          ? "post_apply"
          : "pre_apply",
  };
}

/**
 * Adds only two exact, independently verified official venues. Publication is
 * enabled, but ingestion enrollment remains a separate source-directory act.
 */
export async function addReviewedOfficialVenueDirectoryEntriesHandler(
  ctx: MutationCtx,
  args: EventDomainMigrationBatchArgs,
) {
  const dryRun = args.dryRun ?? true;
  const inspection = await inspectReviewedOfficialVenueDirectoryAdditions(ctx);
  const identityWriteCount = inspection.specs.reduce(
    (count, specInspection) => count + specInspection.claims.length,
    0,
  );
  const counts: EventDomainMigrationBatchCounts = {
    errorCount: 0,
    mismatchCount: inspection.issues.length,
    scannedCount: REVIEWED_OFFICIAL_VENUE_DIRECTORY_ADDITIONS.length,
    unchangedCount:
      inspection.state === "post_apply"
        ? REVIEWED_OFFICIAL_VENUE_DIRECTORY_ADDITIONS.length
        : 0,
    updatedCount:
      inspection.state === "pre_apply"
        ? REVIEWED_OFFICIAL_VENUE_DIRECTORY_ADDITIONS.length * 2 +
          identityWriteCount
        : 0,
  };

  let completionInspection = inspection;

  if (inspection.state === "pre_apply" && !dryRun) {
    const now = Date.now();
    for (const specInspection of inspection.specs) {
      const venueRecord = expectedVenueRecord(specInspection.spec);
      const venueId = await ctx.db.insert("venues", {
        ...venueRecord,
        createdAt: now,
        updatedAt: now,
      });
      for (const claim of specInspection.claims) {
        await upsertClaim(ctx, venueId, claim, "venue_record");
      }
      await ctx.db.insert("venueAuditLog", {
        action: AUDIT_ACTION,
        actor: MIGRATION_ACTOR,
        afterJson: afterAuditJson(
          venueId,
          specInspection.spec,
          specInspection.claims,
        ),
        beforeJson: beforeAuditJson(),
        createdAt: now,
        note: AUDIT_NOTE,
        venueId,
      });
    }
    completionInspection =
      await inspectReviewedOfficialVenueDirectoryAdditions(ctx);
    if (completionInspection.state !== "post_apply") {
      throw new Error(
        `Reviewed official venue additions failed same-transaction final-state attestation: ${completionInspection.issues.join(",") || "unknown_state"}.`,
      );
    }
  }

  await recordEventDomainMigrationProgress({
    counts,
    ctx,
    cursor: "",
    detailJson: JSON.stringify({
      handles: REVIEWED_OFFICIAL_VENUE_DIRECTORY_ADDITIONS.map(
        (spec) => spec.instagramHandle,
      ),
      issues: completionInspection.issues,
      state: completionInspection.state,
    }),
    dryRun,
    inputCursor: args.cursor ?? null,
    isDone: true,
    key: REVIEWED_OFFICIAL_VENUE_DIRECTORY_ADDITIONS_KEY,
    phase: "reviewed_venue_directory_additions",
    restart: args.restart ?? false,
  });
  return {
    ...counts,
    continueCursor: "",
    dryRun,
    isDone: true,
  };
}
