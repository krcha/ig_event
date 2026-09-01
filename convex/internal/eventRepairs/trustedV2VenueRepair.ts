import type { Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import {
  assertExpectedEventStatus,
  assertExpectedEventUpdatedAt,
  hasEventEvidenceV2AutoApproval,
  nextEventUpdatedAt,
} from "../../../lib/events/event-update-precondition";
import {
  buildCanonicalVenueAliasesByHandle,
  buildCanonicalVenueNamesByHandle,
  canonicalizeVenueNameDetailed,
  normalizeHandle,
} from "../../../lib/pipeline/venue-normalization";
import { requireAdminOrServiceSecret } from "../../authz";
import { markSourceOccurrenceTopologyMutation } from "../sourceOccurrenceTopologyEpoch";
import { buildEventOccurrenceIndexPatch } from "../../sourceOccurrences";
import { loadPublicVenueSnapshot } from "../../venueResolver";
import {
  rebindCanonicalVenueProvenance,
  resolveVenueDenormalizedFieldsFromPublicVenues,
} from "../../eventDomain/moderationVenue";
import {
  refreshCanonicalEventDerivedStates,
  writeEventAuditLog,
} from "../../eventDomain/persistence";
import {
  assertApprovalCandidatePolicy,
  assertPersistedServiceSourcePolicy,
  normalizeLookup,
  normalizeSourceCaption,
} from "../../eventDomain/sourceApproval";
import { requireCanonicalInstagramPostUrl } from "../../eventDomain/sourceUrlPolicy";

export async function repairTrustedV2EventVenueHandler(
  ctx: MutationCtx,
  args: {
    id: Id<"events">;
    expectedStatus: "pending" | "approved" | "rejected";
    expectedUpdatedAt: number;
    expectedNormalizedFieldsJson: string;
    nextVenue: string;
    nextNormalizedFieldsJson: string;
    moderationNote: string;
    serviceSecret: string;
  },
) {
  const { actor, kind } = await requireAdminOrServiceSecret(
    ctx,
    args.serviceSecret,
  );
  if (kind !== "service") {
    throw new Error("Trusted v2 venue repair requires service authentication.");
  }
  if (args.moderationNote.trim().length < 20) {
    throw new Error(
      "Trusted v2 venue repair requires a substantive audit note.",
    );
  }
  if (!Number.isSafeInteger(args.expectedUpdatedAt)) {
    throw new Error(
      "Trusted v2 venue repair requires a valid expectedUpdatedAt.",
    );
  }

  const event = await ctx.db.get(args.id);
  if (!event) {
    throw new Error("Event not found.");
  }
  assertExpectedEventStatus(event.status, args.expectedStatus);
  assertExpectedEventUpdatedAt(event.updatedAt, args.expectedUpdatedAt);
  if (event.normalizedFieldsJson !== args.expectedNormalizedFieldsJson) {
    throw new Error("Normalized event evidence changed before venue repair.");
  }
  if (normalizeLookup(event.venue)) {
    throw new Error(
      "Trusted v2 venue repair only accepts an empty current venue.",
    );
  }

  let currentFields: Record<string, unknown>;
  let nextFields: Record<string, unknown>;
  try {
    const current = JSON.parse(args.expectedNormalizedFieldsJson) as unknown;
    const next = JSON.parse(args.nextNormalizedFieldsJson) as unknown;
    if (
      !current ||
      typeof current !== "object" ||
      Array.isArray(current) ||
      !next ||
      typeof next !== "object" ||
      Array.isArray(next)
    ) {
      throw new Error("invalid normalized fields");
    }
    currentFields = current as Record<string, unknown>;
    nextFields = next as Record<string, unknown>;
  } catch {
    throw new Error("Trusted v2 venue repair requires valid normalized JSON.");
  }

  const nextVenue = args.nextVenue
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim();
  if (
    !nextVenue ||
    (typeof currentFields.normalizedVenue === "string" &&
      normalizeLookup(currentFields.normalizedVenue))
  ) {
    throw new Error(
      "Trusted v2 venue repair requires an empty attested venue.",
    );
  }
  const expectedNextFields = { ...currentFields, normalizedVenue: nextVenue };
  if (JSON.stringify(expectedNextFields) !== JSON.stringify(nextFields)) {
    throw new Error("Trusted v2 venue repair may only change normalizedVenue.");
  }
  if (
    currentFields.extractionContractVersion !== "event_evidence_v2" ||
    currentFields.extractionIsEvent !== true ||
    currentFields.sourceGroundingVersion !== 5 ||
    currentFields.sourceGroundingEvidence !==
      "persisted_openai_event_evidence_v2" ||
    currentFields.trustedVenueSource !== true ||
    currentFields.venueEvidenceVerified !== true ||
    (currentFields.extractionMode !== "poster" &&
      currentFields.extractionMode !== "caption_only")
  ) {
    throw new Error("Event is not eligible for the trusted v2 venue repair.");
  }

  const sourceHandle =
    typeof currentFields.sourceGroundingInstagramHandle === "string"
      ? normalizeHandle(currentFields.sourceGroundingInstagramHandle)
      : "";
  const postId = event.instagramPostId?.trim() ?? "";
  const postUrl = requireCanonicalInstagramPostUrl(
    event.instagramPostUrl,
    "Trusted v2 venue repair event source",
  );
  if (!sourceHandle || !postId) {
    throw new Error(
      "Trusted v2 venue repair requires an exact Instagram source identity.",
    );
  }

  const venueSnapshot = await loadPublicVenueSnapshot(ctx);
  const publicVenues = [...venueSnapshot.venueById.values()];
  const venueFields = resolveVenueDenormalizedFieldsFromPublicVenues(
    publicVenues,
    nextVenue,
  );
  const canonicalVenue = venueFields.venueId
    ? publicVenues.find((venue) => venue._id === venueFields.venueId)
    : undefined;
  if (
    !canonicalVenue ||
    canonicalVenue.name !== nextVenue ||
    normalizeHandle(canonicalVenue.instagramHandle) !== sourceHandle ||
    normalizeHandle(venueFields.venueInstagramHandle ?? "") !== sourceHandle
  ) {
    throw new Error(
      "Repaired venue must be the source handle's exact public venue.",
    );
  }

  const sourceRows = await ctx.db
    .query("instagramSources")
    .withIndex("by_handle", (q) => q.eq("handle", sourceHandle))
    .take(2);
  const source = sourceRows.length === 1 ? sourceRows[0] : null;
  const exactCanonicalVenueSource = Boolean(
    source?.active &&
    source.role === "venue" &&
    source.venueId === canonicalVenue._id,
  );
  if (
    !source ||
    !source.active ||
    source.role === "promoter" ||
    (source.venueId !== undefined && source.venueId !== canonicalVenue._id)
  ) {
    throw new Error("Repaired venue is not backed by an active venue source.");
  }

  const canonicalVenueNamesByHandle =
    buildCanonicalVenueNamesByHandle(publicVenues);
  const canonicalVenueAliasesByHandle =
    buildCanonicalVenueAliasesByHandle(publicVenues);
  const rawVenue =
    typeof currentFields.rawVenue === "string"
      ? currentFields.rawVenue.trim()
      : "";
  const rawVenueCanonicalization = canonicalizeVenueNameDetailed(
    rawVenue,
    canonicalVenueNamesByHandle,
    { canonicalVenueAliasesByHandle },
  );
  if (
    (!rawVenue && !exactCanonicalVenueSource) ||
    (rawVenue &&
      normalizeHandle(rawVenueCanonicalization?.handle ?? "") !== sourceHandle)
  ) {
    throw new Error(
      "Persisted model venue does not resolve to the source's canonical venue.",
    );
  }

  const persistedCandidates = await ctx.db
    .query("scrapedPosts")
    .withIndex("by_handle_postId", (q) =>
      q.eq("handle", sourceHandle).eq("postId", postId),
    )
    .take(2);
  const persisted =
    persistedCandidates.length === 1 ? persistedCandidates[0] : null;
  const persistedPostUrl = persisted
    ? requireCanonicalInstagramPostUrl(
        persisted.instagramPostUrl,
        "Trusted v2 venue repair persisted source",
      )
    : "";
  if (
    !persisted ||
    normalizeHandle(persisted.handle) !== sourceHandle ||
    normalizeHandle(persisted.username) !== sourceHandle ||
    persisted.postId !== postId ||
    persistedPostUrl !== postUrl ||
    normalizeSourceCaption(persisted.caption) !==
      normalizeSourceCaption(event.sourceCaption) ||
    persisted.postedAt !== event.sourcePostedAt ||
    persisted.analysisResultJson !== event.rawExtractionJson ||
    persisted.analysisRevision !== (persisted.sourceRevision ?? 1) ||
    persisted.analysisContractVersion !== "event_evidence_v2" ||
    persisted.analysisIsEvent !== true ||
    !persisted.analysisModel?.startsWith("gpt-5-mini")
  ) {
    throw new Error(
      "Trusted v2 venue repair requires the current persisted GPT source.",
    );
  }

  const effectiveEvent = {
    ...event,
    ...venueFields,
    venue: canonicalVenue.name,
    normalizedFieldsJson: args.nextNormalizedFieldsJson,
  };
  if (event.status === "approved") {
    if (
      !hasEventEvidenceV2AutoApproval(
        args.nextNormalizedFieldsJson,
        effectiveEvent,
      )
    ) {
      throw new Error(
        "Approved venue repair must retain complete v2 auto-approval evidence.",
      );
    }
    await assertPersistedServiceSourcePolicy(ctx, effectiveEvent);
    await assertApprovalCandidatePolicy(ctx, effectiveEvent, [event._id]);
  }

  const { affectedRepresentativeIds, topologyMutated } =
    await rebindCanonicalVenueProvenance(ctx, event, effectiveEvent);
  if (topologyMutated) {
    await markSourceOccurrenceTopologyMutation(ctx, { verified: true });
  }

  const updatedAt = nextEventUpdatedAt(event.updatedAt);
  await ctx.db.patch(event._id, {
    venue: canonicalVenue.name,
    normalizedFieldsJson: args.nextNormalizedFieldsJson,
    ...venueFields,
    ...buildEventOccurrenceIndexPatch(effectiveEvent),
    updatedAt,
  });
  await refreshCanonicalEventDerivedStates(ctx, affectedRepresentativeIds);
  await writeEventAuditLog(ctx, event._id, "trusted_v2_venue_repaired", {
    actor,
    note: args.moderationNote.trim(),
    patch: {
      venue: canonicalVenue.name,
      normalizedVenue: canonicalVenue.name,
      sourceHandle,
    },
  });
  return { updated: true, updatedAt, status: event.status };
}
