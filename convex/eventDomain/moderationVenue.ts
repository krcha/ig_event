import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { buildNormalizedEventVenueIdentity } from "../../lib/events/event-venue-identity";
import {
  HUMAN_REVIEWED_LEGACY_SOURCE_POLICY_VERSION,
  HUMAN_REVIEWED_STRUCTURED_SOURCE_POLICY_VERSION,
} from "../../lib/events/event-update-precondition";
import { normalizeHandle } from "../../lib/pipeline/venue-normalization";
import { sourceOccurrenceProvenanceRepository } from "../repositories/sourceOccurrenceProvenance";
import {
  CLEARED_VENUE_DENORMALIZED_FIELDS,
  buildConvexVenueSnapshot,
  loadPublicVenueSnapshot,
  resolveVenueForWrite,
  resolveVenueFromSnapshot,
  type ConvexVenueSnapshot,
  type VenueDenormalizedFields,
} from "../venueResolver";
import {
  assertHumanApprovalSourcePolicy,
  normalizeLookup,
} from "./sourceApproval";

export type PreparedHumanApprovalCandidate = {
  candidate: Doc<"events"> & VenueDenormalizedFields;
  venuePatch: Partial<Doc<"events">> &
    VenueDenormalizedFields & { venue?: string };
};

export function resolveVenueDenormalizedFieldsFromPublicVenues(
  venues: Doc<"venues">[],
  venueName: string | undefined,
): VenueDenormalizedFields {
  return resolveVenueFromSnapshot(buildConvexVenueSnapshot(venues), venueName)
    .venueFields;
}

export type PendingModerationVenueResolver = {
  snapshot: ConvexVenueSnapshot;
  venueById: Map<Id<"venues">, Doc<"venues">>;
  venueByHandle: Map<string, Doc<"venues"> | null>;
  resolvedByLookup: Map<
    string,
    { venueFields: VenueDenormalizedFields; canonicalVenueName?: string }
  >;
};

function addUniqueVenueLookup(
  lookup: Map<string, Doc<"venues"> | null>,
  key: string,
  venue: Doc<"venues">,
): void {
  if (!key) return;
  const existing = lookup.get(key);
  if (existing === undefined) {
    lookup.set(key, venue);
    return;
  }
  if (existing && existing._id !== venue._id) lookup.set(key, null);
}

export function buildPendingModerationVenueResolver(
  venues: Doc<"venues">[],
  identities: Doc<"venueIdentities">[] = [],
): PendingModerationVenueResolver {
  const venueById = new Map<Id<"venues">, Doc<"venues">>();
  const venueByHandle = new Map<string, Doc<"venues"> | null>();
  for (const venue of venues) {
    venueById.set(venue._id, venue);
    addUniqueVenueLookup(
      venueByHandle,
      normalizeHandle(venue.instagramHandle),
      venue,
    );
  }
  for (const identity of identities) {
    if (!identity.active || identity.kind !== "provider_account") continue;
    const venue = venueById.get(identity.venueId);
    if (venue) {
      addUniqueVenueLookup(
        venueByHandle,
        normalizeHandle(identity.rawValue),
        venue,
      );
    }
  }
  return {
    snapshot: buildConvexVenueSnapshot(venues, identities),
    venueById,
    venueByHandle,
    resolvedByLookup: new Map(),
  };
}

function resolveVenueForPendingModeration(
  resolver: PendingModerationVenueResolver,
  venueName: string,
): { venueFields: VenueDenormalizedFields; canonicalVenueName?: string } {
  const lookupName = normalizeLookup(venueName);
  if (!lookupName) {
    return { venueFields: CLEARED_VENUE_DENORMALIZED_FIELDS };
  }
  const cached = resolver.resolvedByLookup.get(lookupName);
  if (cached) return cached;
  const resolved = resolveVenueFromSnapshot(resolver.snapshot, venueName);
  resolver.resolvedByLookup.set(lookupName, resolved);
  return resolved;
}

export function prepareHumanApprovalCandidateFromVenueResolver(
  event: Doc<"events">,
  resolver: PendingModerationVenueResolver,
): PreparedHumanApprovalCandidate {
  const existingVenue =
    (event.venueId ? resolver.venueById.get(event.venueId) : undefined) ??
    (event.venueInstagramHandle
      ? resolver.venueByHandle.get(normalizeHandle(event.venueInstagramHandle))
      : undefined);
  const { venueFields, canonicalVenueName } = existingVenue
    ? {
        venueFields: {
          ...CLEARED_VENUE_DENORMALIZED_FIELDS,
          ...buildNormalizedEventVenueIdentity({
            venue: existingVenue.name,
            venueInstagramHandle: existingVenue.instagramHandle,
          }),
          venueCategory: existingVenue.category,
          venueId: existingVenue._id,
          venueInstagramHandle: existingVenue.instagramHandle,
          ...(existingVenue.latitude !== undefined
            ? { venueLatitude: existingVenue.latitude }
            : {}),
          ...(existingVenue.location
            ? { venueLocation: existingVenue.location }
            : {}),
          ...(existingVenue.longitude !== undefined
            ? { venueLongitude: existingVenue.longitude }
            : {}),
        },
        canonicalVenueName: existingVenue.name,
      }
    : resolveVenueForPendingModeration(resolver, event.venue);
  const venuePatch = {
    ...venueFields,
    ...(canonicalVenueName && canonicalVenueName !== event.venue
      ? { venue: canonicalVenueName }
      : {}),
  };
  return { candidate: { ...event, ...venuePatch }, venuePatch };
}

export async function resolveVenueDenormalizedFields(
  ctx: QueryCtx | MutationCtx,
  venueName: string | undefined,
): Promise<VenueDenormalizedFields> {
  return (await resolveVenueForWrite(ctx, venueName)).venueFields;
}

export async function prepareHumanApprovalCandidate(
  ctx: MutationCtx,
  event: Doc<"events">,
): Promise<PreparedHumanApprovalCandidate> {
  const snapshot = await loadPublicVenueSnapshot(ctx);
  const resolution = resolveVenueFromSnapshot(snapshot, event.venue);
  const definedVenueFields = Object.fromEntries(
    Object.entries(resolution.venueFields).filter(
      ([, value]) => value !== undefined,
    ),
  ) as VenueDenormalizedFields;
  const venuePatch = {
    ...definedVenueFields,
    ...(resolution.canonicalVenueName &&
    resolution.canonicalVenueName !== event.venue
      ? { venue: resolution.canonicalVenueName }
      : {}),
  };
  return { candidate: { ...event, ...venuePatch }, venuePatch };
}

export type SourceOccurrenceVenueRebindResult = {
  affectedRepresentativeIds: Id<"events">[];
  topologyMutated: boolean;
};

function sourceOccurrenceVenueIdentityChanged(
  currentEvent: Doc<"events">,
  nextEvent: Doc<"events">,
): boolean {
  return [
    "venue",
    "venueId",
    "normalizedVenueIdentity",
    "normalizedVenueInstagramHandle",
  ].some(
    (field) =>
      currentEvent[field as keyof Doc<"events">] !==
      nextEvent[field as keyof Doc<"events">],
  );
}

export async function rebindCanonicalVenueProvenance(
  ctx: MutationCtx,
  currentEvent: Doc<"events">,
  nextEvent: Doc<"events">,
): Promise<SourceOccurrenceVenueRebindResult> {
  const topologyMutated =
    sourceOccurrenceVenueIdentityChanged(currentEvent, nextEvent) &&
    (
      await ctx.db
        .query("instagramEventSources")
        .withIndex("by_event", (q) => q.eq("eventId", currentEvent._id))
        .take(1)
    ).length > 0;
  const affectedRepresentativeIds =
    await sourceOccurrenceProvenanceRepository.rebindCanonicalVenue(
      ctx,
      currentEvent,
      nextEvent,
      { topologyEpochVerified: true },
    );
  return { affectedRepresentativeIds, topologyMutated };
}

export async function rebindHumanApprovalVenueProvenance(
  ctx: MutationCtx,
  event: Doc<"events">,
  prepared: PreparedHumanApprovalCandidate,
): Promise<SourceOccurrenceVenueRebindResult> {
  return rebindCanonicalVenueProvenance(ctx, event, prepared.candidate);
}

export async function eventRejectionInvalidatesVerifiedReceiptTopology(
  ctx: MutationCtx,
  eventId: Id<"events">,
): Promise<boolean> {
  const [sourceLinks, occurrences] = await Promise.all([
    ctx.db
      .query("instagramEventSources")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .take(1),
    sourceOccurrenceProvenanceRepository.listForCanonicalEvent(ctx, eventId),
  ]);
  return (
    sourceLinks.length > 0 ||
    occurrences.some((occurrence) => occurrence.state !== "superseded")
  );
}

function rebindStructuredHumanReviewToCanonicalVenue(
  humanReviewPatch: {
    normalizedFieldsJson?: string;
    humanReviewedLegacySourcePolicyVersion?: typeof HUMAN_REVIEWED_LEGACY_SOURCE_POLICY_VERSION;
    humanReviewedStructuredSourcePolicyVersion?: typeof HUMAN_REVIEWED_STRUCTURED_SOURCE_POLICY_VERSION;
  },
  venuePatch: Partial<Doc<"events">> & VenueDenormalizedFields,
): typeof humanReviewPatch {
  const canonicalVenue = venuePatch.venue?.trim();
  if (
    !canonicalVenue ||
    humanReviewPatch.humanReviewedStructuredSourcePolicyVersion !==
      HUMAN_REVIEWED_STRUCTURED_SOURCE_POLICY_VERSION ||
    !humanReviewPatch.normalizedFieldsJson
  ) {
    return humanReviewPatch;
  }
  const normalizedFields = JSON.parse(
    humanReviewPatch.normalizedFieldsJson,
  ) as Record<string, unknown>;
  return {
    ...humanReviewPatch,
    normalizedFieldsJson: JSON.stringify({
      ...normalizedFields,
      normalizedVenue: canonicalVenue,
      humanReviewedVenueCanonicalizationPolicyVersion: 1,
    }),
  };
}

export async function assertHumanApprovalWithCanonicalVenueFallback(
  ctx: QueryCtx | MutationCtx,
  sourceEvent: Doc<"events">,
  prepared: PreparedHumanApprovalCandidate,
  moderationNote: string | undefined,
) {
  try {
    return await assertHumanApprovalSourcePolicy(
      ctx,
      prepared.candidate,
      moderationNote,
    );
  } catch (error) {
    if (
      !prepared.venuePatch.venue ||
      !(error instanceof Error) ||
      error.message !==
        "Human approval requires complete canonical Instagram source grounding for the final public fields."
    ) {
      throw error;
    }
  }
  const sourceHumanReviewPatch = await assertHumanApprovalSourcePolicy(
    ctx,
    sourceEvent,
    moderationNote,
  );
  return rebindStructuredHumanReviewToCanonicalVenue(
    sourceHumanReviewPatch,
    prepared.venuePatch,
  );
}
