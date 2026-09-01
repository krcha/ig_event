import type { FunctionReference } from "convex/server";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation } from "./_generated/server";
import {
  evaluatePublicationEligibility,
  PUBLICATION_POLICY_VERSION,
  type PublicationDecision,
} from "../lib/domain/publication/policy";
import { isCanonicallyGroundedApprovedEvent } from "./publicEventGrounding";
import { isVenuePublic } from "../lib/venues/venue-lifecycle";
import {
  normalizeHandle,
  normalizeVenueComparableText,
} from "../lib/pipeline/venue-normalization";
import { hasCompleteEventVenueBindingCoverage } from "./internal/eventVenueBindingCoverage";

const MAX_SOURCE_IDENTITIES_PER_EVENT = 12;
const MAX_SOURCE_OCCURRENCES_PER_IDENTITY = 64;
const MAX_PUBLICATION_OCCURRENCE_READ_BUDGET = 96;
export const MAX_PUBLICATION_REFRESH_EVENTS = 64;
const MAX_INLINE_PUBLICATION_REFRESH_EVENTS = 16;
const VENUE_PUBLICATION_REFRESH_PAGE_SIZE = 16;
const MAX_LEGACY_EVENT_VENUE_IDENTITY_MATCHES = 8;
const refreshVenuePublicationPageMutation =
  "publicationPolicy:refreshVenuePublicationPage" as unknown as FunctionReference<
    "mutation",
    "internal"
  >;
const refreshEventPublicationBatchMutation =
  "publicationPolicy:refreshEventPublicationBatch" as unknown as FunctionReference<
    "mutation",
    "internal"
  >;

export function toPublicationPatch(
  decision: PublicationDecision,
  evaluatedAt = Date.now(),
) {
  return {
    publicationEvaluatedAt: evaluatedAt,
    publicationPolicyVersion: decision.policyVersion,
    publicationReason: decision.reason,
    publicationState: decision.state,
  } as const;
}

/**
 * Convex adapter for the single publication policy. Legacy events without
 * first-class occurrences retain their existing grounding behavior during the
 * migration; once occurrences exist, all must be satisfied.
 */
export async function evaluateEventPublication(
  ctx: QueryCtx | MutationCtx,
  event: Doc<"events">,
  options: { venueOverride?: Doc<"venues"> } = {},
): Promise<PublicationDecision> {
  if (event.status !== "approved") {
    return evaluatePublicationEligibility({
      canonicalSourceGroundingVerified: false,
      moderationStatus: event.status,
    });
  }
  const attachedOccurrences = await ctx.db
    .query("sourceOccurrences")
    .withIndex("by_canonical_event", (q) => q.eq("canonicalEventId", event._id))
    .take(MAX_SOURCE_IDENTITIES_PER_EVENT + 1);
  const currentAttachedOccurrences = attachedOccurrences.filter(
    (occurrence) => occurrence.state !== "superseded",
  );
  const sourceIdentities = [
    ...new Set(currentAttachedOccurrences.map((occurrence) => occurrence.sourceIdentity)),
  ];
  let occurrenceComplete: boolean | undefined;
  if (attachedOccurrences.length > MAX_SOURCE_IDENTITIES_PER_EVENT) {
    occurrenceComplete = false;
  } else if (attachedOccurrences.length > 0 && sourceIdentities.length === 0) {
    // Once first-class provenance exists, an all-superseded attachment set is
    // not equivalent to a never-migrated legacy event.
    occurrenceComplete = false;
  } else if (sourceIdentities.length > 0) {
    const occurrenceBatches: Doc<"sourceOccurrences">[][] = [];
    let remainingReadBudget = MAX_PUBLICATION_OCCURRENCE_READ_BUDGET;
    let occurrenceReadWithinBudget = true;
    for (const sourceIdentity of sourceIdentities) {
      const perIdentityLimit = Math.min(
        MAX_SOURCE_OCCURRENCES_PER_IDENTITY,
        remainingReadBudget,
      );
      const occurrences = await ctx.db
        .query("sourceOccurrences")
        .withIndex("by_source_occurrence", (q) =>
          q.eq("sourceIdentity", sourceIdentity),
        )
        .take(perIdentityLimit + 1);
      if (occurrences.length > perIdentityLimit) {
        occurrenceReadWithinBudget = false;
        break;
      }
      occurrenceBatches.push(occurrences);
      remainingReadBudget -= occurrences.length;
    }
    const currentOccurrences = occurrenceBatches.flatMap((occurrences) =>
      occurrences.filter((occurrence) => occurrence.state !== "superseded"),
    );
    if (!occurrenceReadWithinBudget) {
      occurrenceComplete = false;
    } else {
      const representativeIds = [
        ...new Set(
          currentOccurrences
            .map((occurrence) => occurrence.canonicalEventId)
            .filter(
              (eventId): eventId is Doc<"events">["_id"] => eventId !== undefined,
            ),
        ),
      ];
      const representatives = await Promise.all(
        representativeIds.map((eventId) => ctx.db.get(eventId)),
      );
      const existingRepresentativeIds = new Set(
        representatives
          .filter((representative): representative is Doc<"events"> => representative !== null)
          .map((representative) => representative._id),
      );
      occurrenceComplete = currentOccurrences.every(
        (occurrence) =>
          occurrence.state === "satisfied" &&
          occurrence.canonicalEventId !== undefined &&
          existingRepresentativeIds.has(occurrence.canonicalEventId),
      );
    }
  }
  const venue = event.venueId
    ? await ctx.db.get(event.venueId)
    : options.venueOverride ?? null;
  const venueResolutionStatus = currentAttachedOccurrences.some(
    (occurrence) => occurrence.venueResolutionStatus === "ambiguous",
  )
    ? ("ambiguous" as const)
    : currentAttachedOccurrences.some(
          (occurrence) => occurrence.venueResolutionStatus === "unresolved",
        )
      ? ("unresolved" as const)
      : currentAttachedOccurrences.length > 0
        ? ("resolved" as const)
        : options.venueOverride
          ? ("resolved" as const)
          : undefined;
  return evaluatePublicationEligibility({
    canonicalSourceGroundingVerified: await isCanonicallyGroundedApprovedEvent(
      ctx,
      event,
    ),
    moderationStatus: event.status,
    occurrenceComplete,
    ...(event.venueId || options.venueOverride
      ? { venuePublic: Boolean(venue && isVenuePublic(venue)) }
      : {}),
    venueResolutionStatus,
  });
}

/**
 * Authoritative public-read adapter during the strangler migration. A current
 * materialized decision is mandatory once either publication field exists,
 * and every publishable row must still pass its bounded live grounding proof.
 * Callers may explicitly preserve never-migrated approved rows, but stale or
 * non-publishable materialized rows always fail closed.
 */
export async function isEventPubliclyVisible(
  ctx: QueryCtx | MutationCtx,
  event: Doc<"events">,
  options: { allowNeverMigratedApproved?: boolean } = {},
): Promise<boolean> {
  if (event.status !== "approved") return false;
  if (event.venueId) {
    const venue = await ctx.db.get(event.venueId);
    if (!venue || !isVenuePublic(venue)) return false;
  } else {
    const normalizedHandle = normalizeHandle(
      event.normalizedVenueInstagramHandle ?? event.venueInstagramHandle ?? "",
    );
    const normalizedName = normalizeVenueComparableText(event.venue);
    const identityBatches = await Promise.all([
      normalizedHandle
        ? ctx.db
            .query("venueIdentities")
            .withIndex("by_provider_normalized", (q) =>
              q
                .eq("provider", "instagram")
                .eq("normalizedValue", normalizedHandle),
            )
            .take(MAX_LEGACY_EVENT_VENUE_IDENTITY_MATCHES + 1)
        : Promise.resolve([] as Doc<"venueIdentities">[]),
      ...(["canonical_name", "alias", "historical_alias"] as const).map((kind) =>
        normalizedName
          ? ctx.db
              .query("venueIdentities")
              .withIndex("by_kind_normalized", (q) =>
                q.eq("kind", kind).eq("normalizedValue", normalizedName),
              )
              .take(MAX_LEGACY_EVENT_VENUE_IDENTITY_MATCHES + 1)
          : Promise.resolve([] as Doc<"venueIdentities">[]),
      ),
    ]);
    if (
      identityBatches.some(
        (batch) => batch.length > MAX_LEGACY_EVENT_VENUE_IDENTITY_MATCHES,
      )
    ) {
      return false;
    }
    const legacyVenueIds = [
      ...new Set(
        identityBatches
          .flat()
          .filter((identity) => identity.active)
          .map((identity) => identity.venueId),
      ),
    ];
    if (legacyVenueIds.length > 1) return false;
    if (legacyVenueIds.length === 1) {
      const venue = await ctx.db.get(legacyVenueIds[0]!);
      if (!venue || !isVenuePublic(venue)) return false;
    } else if (await hasCompleteEventVenueBindingCoverage(ctx)) {
      // Once the migration proves every eligible historical row was bound,
      // an approved event without a venueId is an invariant violation.
      return false;
    }
  }
  const hasMaterializedDecision =
    event.publicationPolicyVersion !== undefined ||
    event.publicationState !== undefined;
  if (hasMaterializedDecision) {
    if (
      event.publicationPolicyVersion !== PUBLICATION_POLICY_VERSION ||
      event.publicationState !== "publishable"
    ) {
      return false;
    }
    return isCanonicallyGroundedApprovedEvent(ctx, event);
  }
  return options.allowNeverMigratedApproved === true
    ? true
    : isCanonicallyGroundedApprovedEvent(ctx, event);
}

/**
 * Refreshes every canonical representative affected when a source occurrence
 * receipt advances. Publication fields are derived metadata, so this does not
 * alter the canonical event's optimistic `updatedAt` version.
 */
async function refreshEventPublicationStatesInline(
  ctx: MutationCtx,
  eventIds: readonly Doc<"events">["_id"][],
  options: { venueOverride?: Doc<"venues"> } = {},
): Promise<void> {
  const events = await Promise.all(eventIds.map((eventId) => ctx.db.get(eventId)));
  for (const event of events) {
    if (!event) continue;
    const decision = await evaluateEventPublication(ctx, event, options);
    const patch = toPublicationPatch(decision);
    if (
      event.publicationPolicyVersion !== patch.publicationPolicyVersion ||
      event.publicationReason !== patch.publicationReason ||
      event.publicationState !== patch.publicationState
    ) {
      await ctx.db.patch(event._id, patch);
    }
  }
}

export async function refreshEventPublicationStates(
  ctx: MutationCtx,
  eventIds: readonly Doc<"events">["_id"][],
): Promise<void> {
  const uniqueIds = [...new Set(eventIds)];
  if (uniqueIds.length > MAX_PUBLICATION_REFRESH_EVENTS) {
    throw new Error("Publication refresh event set exceeds the safe bounded load.");
  }
  if (uniqueIds.length <= MAX_INLINE_PUBLICATION_REFRESH_EVENTS) {
    await refreshEventPublicationStatesInline(ctx, uniqueIds);
    return;
  }

  const events = await Promise.all(uniqueIds.map((eventId) => ctx.db.get(eventId)));
  const evaluatedAt = Date.now();
  for (const event of events) {
    if (!event) continue;
    await ctx.db.patch(event._id, {
      publicationEvaluatedAt: evaluatedAt,
      publicationPolicyVersion: PUBLICATION_POLICY_VERSION,
      publicationReason: "derived_state_refresh_deferred",
      publicationState: "pending_verification",
    });
  }
  const scheduler = (ctx as { scheduler?: MutationCtx["scheduler"] }).scheduler;
  if (scheduler) {
    await scheduler.runAfter(0, refreshEventPublicationBatchMutation, {
      eventIds: uniqueIds,
      offset: 0,
    });
  }
}

export const refreshEventPublicationBatch = internalMutation({
  args: {
    eventIds: v.array(v.id("events")),
    offset: v.number(),
  },
  returns: v.object({
    complete: v.boolean(),
    nextOffset: v.number(),
    refreshedCount: v.number(),
  }),
  handler: async (ctx, args) => {
    const uniqueIds = [...new Set(args.eventIds)];
    if (
      uniqueIds.length !== args.eventIds.length ||
      uniqueIds.length > MAX_PUBLICATION_REFRESH_EVENTS ||
      !Number.isSafeInteger(args.offset) ||
      args.offset < 0 ||
      args.offset > uniqueIds.length
    ) {
      throw new Error("Invalid bounded publication refresh batch.");
    }
    const batch = uniqueIds.slice(
      args.offset,
      args.offset + MAX_INLINE_PUBLICATION_REFRESH_EVENTS,
    );
    await refreshEventPublicationStatesInline(ctx, batch);
    const nextOffset = args.offset + batch.length;
    const complete = nextOffset >= uniqueIds.length;
    if (!complete) {
      await ctx.scheduler.runAfter(0, refreshEventPublicationBatchMutation, {
        eventIds: uniqueIds,
        offset: nextOffset,
      });
    }
    return { complete, nextOffset, refreshedCount: batch.length };
  },
});

export async function scheduleVenuePublicationRefresh(
  ctx: MutationCtx,
  venueId: Doc<"venues">["_id"],
): Promise<void> {
  await ctx.scheduler.runAfter(0, refreshVenuePublicationPageMutation, {
    cursor: null,
    phase: "venue_id",
    venueId,
  });
}

/** Bounded asynchronous refresh after a venue lifecycle transition. */
export const refreshVenuePublicationPage = internalMutation({
  args: {
    cursor: v.union(v.string(), v.null()),
    phase: v.union(
      v.literal("venue_id"),
      v.literal("legacy_handle"),
      v.literal("legacy_name"),
    ),
    venueId: v.id("venues"),
  },
  returns: v.object({
    continueCursor: v.string(),
    isDone: v.boolean(),
    phase: v.union(
      v.literal("venue_id"),
      v.literal("legacy_handle"),
      v.literal("legacy_name"),
    ),
    refreshedCount: v.number(),
  }),
  handler: async (ctx, args) => {
    const venue = await ctx.db.get(args.venueId);
    if (!venue) {
      throw new Error("Venue disappeared during publication refresh.");
    }
    const normalizedHandle = normalizeHandle(venue.instagramHandle ?? "");
    const normalizedName = normalizeVenueComparableText(venue.name);
    const paginationOpts = {
      cursor: args.cursor,
      numItems: VENUE_PUBLICATION_REFRESH_PAGE_SIZE,
    };
    const page =
      args.phase === "venue_id"
        ? await ctx.db
            .query("events")
            .withIndex("by_venueId", (q) => q.eq("venueId", args.venueId))
            .paginate(paginationOpts)
        : args.phase === "legacy_handle" && normalizedHandle
          ? await ctx.db
              .query("events")
              .withIndex("by_normalizedVenueHandle_status_date", (q) =>
                q
                  .eq("normalizedVenueInstagramHandle", normalizedHandle)
                  .eq("status", "approved"),
              )
              .paginate(paginationOpts)
          : args.phase === "legacy_name" && normalizedName
            ? await ctx.db
                .query("events")
                .withIndex("by_normalizedVenueIdentity_status_date", (q) =>
                  q
                    .eq("normalizedVenueIdentity", normalizedName)
                    .eq("status", "approved"),
                )
                .paginate(paginationOpts)
            : {
                continueCursor: "",
                isDone: true,
                page: [] as Doc<"events">[],
              };
    const refreshEvents =
      args.phase === "venue_id"
        ? page.page
        : page.page.filter((event) => event.venueId === undefined);
    await refreshEventPublicationStatesInline(
      ctx,
      refreshEvents.map((event) => event._id),
      args.phase === "venue_id" ? {} : { venueOverride: venue },
    );

    const nextPhase =
      args.phase === "venue_id"
        ? ("legacy_handle" as const)
        : args.phase === "legacy_handle"
          ? ("legacy_name" as const)
          : null;
    if (!page.isDone || nextPhase) {
      await ctx.scheduler.runAfter(0, refreshVenuePublicationPageMutation, {
        cursor: page.isDone ? null : page.continueCursor,
        phase: page.isDone && nextPhase ? nextPhase : args.phase,
        venueId: args.venueId,
      });
    }
    return {
      continueCursor: page.continueCursor,
      isDone: page.isDone && nextPhase === null,
      phase: args.phase,
      refreshedCount: refreshEvents.length,
    };
  },
});
