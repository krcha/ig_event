import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { buildInstagramSourceOccurrenceFingerprint } from "../../../lib/domain/occurrences/source-fingerprint";
import { adaptInstagramScrapedPostToSourceDocument } from "../../../lib/domain/source-documents";
import { canonicalizeSourceUrlOrEmpty } from "../../../lib/domain/source-url";
import {
  assertExpectedEventUpdatedAt,
  hasAutomaticUniqueStructuredSourceAttestation,
  hasEventEvidenceV2AutoApproval,
  nextEventUpdatedAt,
} from "../../../lib/events/event-update-precondition";
import { normalizeHandle } from "../../../lib/pipeline/venue-normalization";
import { isVenuePublic } from "../../../lib/venues/venue-lifecycle";
import { requireAdminOrServiceSecret } from "../../authz";
import { rebindCanonicalVenueProvenance } from "../../eventDomain/moderationVenue";
import {
  refreshCanonicalEventDerivedStates,
  writeEventAuditLog,
} from "../../eventDomain/persistence";
import {
  assertApprovalCandidatePolicy,
  assertPersistedServiceSourcePolicy,
  normalizeSourceCaption,
} from "../../eventDomain/sourceApproval";
import { requireCanonicalInstagramPostUrl } from "../../eventDomain/sourceUrlPolicy";
import { markSourceOccurrenceTopologyMutation } from "../sourceOccurrenceTopologyEpoch";
import { isCanonicallyGroundedApprovedEvent } from "../../publicEventGrounding";
import { sourceOccurrenceProvenanceRepository } from "../../repositories/sourceOccurrenceProvenance";
import { buildEventOccurrenceIndexPatch } from "../../sourceOccurrences";
import { resolveVenueClaimsForWrite } from "../../venueResolver";

// Production source evidence established affected cohorts from 25 through 29
// September 2026, Belgrade time. A later regression needs a fresh audit.
const COHORT_START_MS = Date.parse("2026-09-24T22:00:00Z");
const COHORT_END_MS = Date.parse("2026-09-29T22:00:00Z");

function readObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseObjectJson(value: string | undefined): Record<string, unknown> | null {
  if (!value) return null;
  try {
    return readObject(JSON.parse(value) as unknown);
  } catch {
    return null;
  }
}

function stringClaim(value: unknown): string {
  return typeof value === "string" ? value.normalize("NFKC").trim() : "";
}

/** Returns only venue claims attached to this event's source row. Repeated
 * identical source text can bind a venue only when every matching row states
 * a physical venue; the catalog gate below must resolve all of them alike. */
export function sourceBoundEmptyV2VenueClaimsForTesting(
  fields: Record<string, unknown>,
  raw: Record<string, unknown>,
): string[] | null {
  const rawVenue = stringClaim(fields.rawVenue);
  const conflicts = raw.source_conflicts;
  const normalizedConflicts = fields.extractionSourceConflicts;
  if (
    !rawVenue ||
    stringClaim(fields.normalizedVenue) ||
    raw.extraction_contract_version !== "event_evidence_v2" ||
    raw.is_event !== true ||
    !Array.isArray(conflicts) ||
    conflicts.some((item) => readObject(item)?.field === "venue") ||
    (Array.isArray(normalizedConflicts) &&
      normalizedConflicts.some((item) => readObject(item)?.field === "venue"))
  ) return null;

  const claims = [rawVenue];
  const topLevelVenue = stringClaim(raw.venue);
  if (topLevelVenue) claims.push(topLevelVenue);

  const shared = readObject(raw.shared_schedule_context);
  const sharedVenue = readObject(shared?.venue);
  const sharedValue = stringClaim(sharedVenue?.value);
  if (sharedValue) claims.push(sharedValue);

  const entries = raw.schedule_entries;
  if (!Array.isArray(entries) || entries.length > 64) return null;
  const rowSourceText = stringClaim(fields.rowSourceText);
  if (entries.length > 0) {
    if (!rowSourceText) return null;
    const matchingRows = entries
      .map(readObject)
      .filter((row) => row?.source_text === rowSourceText);
    if (matchingRows.length === 0) return null;
    if (
      matchingRows.length > 1 &&
      matchingRows.some((row) => !stringClaim(row?.venue))
    ) return null;
    for (const row of matchingRows) {
      const selectedVenue = stringClaim(row?.venue);
      if (selectedVenue) claims.push(selectedVenue);
    }
  } else if (rowSourceText) {
    return null;
  }

  return [...new Set(claims)];
}

/** A secondary post has its own durable source identity and analysis. The
 * canonical event link's display post URL may still name the primary post, so
 * its sourceIdentity and fingerprint are the authorities for this proof. */
export function currentSecondarySourceVenueClaimsForTesting(
  post: Doc<"scrapedPosts">,
  link: Pick<Doc<"instagramEventSources">, "sourceIdentity" | "sourceFingerprint">,
  sourceHandle: string,
): string[] | null {
  if (
    normalizeHandle(post.handle) !== sourceHandle ||
    normalizeHandle(post.username) !== sourceHandle ||
    !post.postId?.trim() ||
    !post.canonicalSourceUrl ||
    post.analysisRevision !== (post.sourceRevision ?? 1) ||
    post.analysisContractVersion !== "event_evidence_v2" ||
    post.analysisIsEvent !== true ||
    !post.analysisModel?.startsWith("gpt-5-mini") ||
    !post.analysisResultJson ||
    buildInstagramSourceOccurrenceFingerprint(post) !== link.sourceFingerprint
  ) return null;

  try {
    if (
      adaptInstagramScrapedPostToSourceDocument(post).sourceIdentity !==
        link.sourceIdentity ||
      requireCanonicalInstagramPostUrl(
        post.instagramPostUrl,
        "Source-bound venue repair secondary post",
      ) !== post.canonicalSourceUrl
    ) return null;
  } catch {
    return null;
  }

  const raw = parseObjectJson(post.analysisResultJson);
  const conflicts = raw?.source_conflicts;
  const entries = raw?.schedule_entries;
  const shared = readObject(raw?.shared_schedule_context);
  const sharedVenue = readObject(shared?.venue);
  const topLevelVenue = stringClaim(raw?.venue);
  if (
    !raw ||
    raw.extraction_contract_version !== "event_evidence_v2" ||
    raw.is_event !== true ||
    canonicalizeSourceUrlOrEmpty(
      "instagram",
      typeof raw.source_url === "string" ? raw.source_url : undefined,
    ) !== post.canonicalSourceUrl ||
    normalizeSourceCaption(
      typeof raw.source_caption === "string" ? raw.source_caption : undefined,
    ) !== normalizeSourceCaption(post.caption) ||
    !topLevelVenue ||
    !Array.isArray(conflicts) ||
    conflicts.some((item) => readObject(item)?.field === "venue") ||
    !sharedVenue ||
    !Array.isArray(entries) ||
    entries.length < 1 ||
    entries.length > 64
  ) return null;

  const claims = [topLevelVenue];
  const sharedClaim = stringClaim(sharedVenue.value);
  if (sharedClaim) claims.push(sharedClaim);
  for (const entry of entries) {
    const venue = stringClaim(readObject(entry)?.venue);
    if (!venue) return null;
    claims.push(venue);
  }
  return [...new Set(claims)];
}

export async function repairSourceBoundEmptyV2VenueHandler(
  ctx: MutationCtx,
  args: {
    id: Id<"events">;
    expectedUpdatedAt: number;
    expectedNormalizedFieldsJson: string;
    venueId: Id<"venues">;
    expectedVenueUpdatedAt: number;
    expectedSourceUpdatedAt: number;
    moderationNote: string;
    serviceSecret: string;
  },
) {
  const { actor, kind } = await requireAdminOrServiceSecret(
    ctx,
    args.serviceSecret,
  );
  if (kind !== "service" || args.moderationNote.trim().length < 20) {
    throw new Error("Source-bound venue repair requires service authentication and a substantive audit note.");
  }
  if (
    !Number.isSafeInteger(args.expectedUpdatedAt) ||
    !Number.isSafeInteger(args.expectedVenueUpdatedAt) ||
    !Number.isSafeInteger(args.expectedSourceUpdatedAt)
  ) {
    throw new Error("Source-bound venue repair requires exact event, venue, and source versions.");
  }

  const event = await ctx.db.get(args.id);
  const venue = await ctx.db.get(args.venueId);
  if (!event || !venue) throw new Error("Event or venue not found.");
  assertExpectedEventUpdatedAt(event.updatedAt, args.expectedUpdatedAt);
  if (
    event.status !== "approved" ||
    event.createdAt < COHORT_START_MS ||
    event.createdAt >= COHORT_END_MS ||
    event.normalizedFieldsJson !== args.expectedNormalizedFieldsJson ||
    event.venue.trim() ||
    event.venueId ||
    event.venueInstagramHandle ||
    event.normalizedVenueIdentity ||
    event.reviewedAt !== undefined ||
    event.reviewedBy !== undefined ||
    venue.updatedAt !== args.expectedVenueUpdatedAt ||
    !isVenuePublic(venue)
  ) {
    throw new Error("Event or public venue changed or is outside the approved empty-venue cohort.");
  }

  const fields = parseObjectJson(event.normalizedFieldsJson);
  const raw = parseObjectJson(event.rawExtractionJson);
  const claims = fields && raw
    ? sourceBoundEmptyV2VenueClaimsForTesting(fields, raw)
    : null;
  const sourceHandle = normalizeHandle(
    stringClaim(fields?.sourceGroundingInstagramHandle),
  );
  const venueHandle = normalizeHandle(venue.instagramHandle);
  if (
    !fields || !raw || !claims || !sourceHandle ||
    venueHandle !== sourceHandle ||
    fields.extractionContractVersion !== "event_evidence_v2" ||
    fields.extractionIsEvent !== true ||
    fields.sourceGroundingVersion !== 5 ||
    fields.sourceGroundingEvidence !== "persisted_openai_event_evidence_v2" ||
    fields.sourceAccountRole !== "venue" ||
    fields.trustedVenueSource !== false ||
    (fields.extractionMode !== "poster" && fields.extractionMode !== "caption_only") ||
    (fields.moderationAutoApproveRule !== "event_evidence_v2" &&
      fields.moderationAutoApproveRule !== "server_verified_unique_v1") ||
    fields.moderationAutoApproved !== true ||
    fields.sourceOccurrenceKey !== event.sourceOccurrenceKey ||
    !event.sourceOccurrenceKey ||
    (Array.isArray(event.sourceConflictFields) && event.sourceConflictFields.length > 0)
  ) {
    throw new Error("Event lacks exact source-bound v2 venue evidence.");
  }

  const sourceRows = await ctx.db
    .query("instagramSources")
    .withIndex("by_handle", (q) => q.eq("handle", sourceHandle))
    .take(2);
  const source = sourceRows.length === 1 ? sourceRows[0] : null;
  if (
    !source || !source.active || source.role !== "venue" ||
    source.venueId !== venue._id ||
    source.updatedAt !== args.expectedSourceUpdatedAt
  ) {
    throw new Error("Posting source is not the unchanged active catalog venue account.");
  }

  const resolvedClaims = await resolveVenueClaimsForWrite(ctx, [
    ...claims,
    venue.name,
  ]);
  if (claims.some((claim) => {
    const resolved = resolvedClaims.get(claim);
    return resolved?.resolution.status !== "resolved" ||
      resolved.venueFields.venueId !== venue._id ||
      resolved.canonicalVenueName !== venue.name;
  })) {
    throw new Error("A saved model, shared, or selected-row venue claim is ambiguous or offsite.");
  }
  const canonical = resolvedClaims.get(venue.name);
  if (
    canonical?.resolution.status !== "resolved" ||
    canonical.venueFields.venueId !== venue._id ||
    normalizeHandle(canonical.venueFields.venueInstagramHandle ?? "") !== sourceHandle
  ) {
    throw new Error("Catalog venue no longer resolves to the exact posting handle.");
  }

  const postId = event.instagramPostId?.trim() ?? "";
  const eventPostUrl = requireCanonicalInstagramPostUrl(
    event.instagramPostUrl,
    "Source-bound venue repair event",
  );
  if (
    !postId ||
    fields.sourceGroundingInstagramPostId !== postId ||
    requireCanonicalInstagramPostUrl(
      stringClaim(fields.sourceGroundingInstagramPostUrl),
      "Source-bound venue repair attestation",
    ) !== eventPostUrl ||
    normalizeSourceCaption(stringClaim(fields.sourceGroundingSourceCaption)) !==
      normalizeSourceCaption(event.sourceCaption)
  ) {
    throw new Error("Event source identity does not match the persisted attestation.");
  }
  const postRows = await ctx.db
    .query("scrapedPosts")
    .withIndex("by_handle_postId", (q) =>
      q.eq("handle", sourceHandle).eq("postId", postId),
    )
    .take(2);
  const post = postRows.length === 1 ? postRows[0] : null;
  if (
    !post ||
    normalizeHandle(post.handle) !== sourceHandle ||
    normalizeHandle(post.username) !== sourceHandle ||
    requireCanonicalInstagramPostUrl(
      post.instagramPostUrl,
      "Source-bound venue repair saved post",
    ) !== eventPostUrl ||
    normalizeSourceCaption(post.caption) !== normalizeSourceCaption(event.sourceCaption) ||
    post.postedAt !== event.sourcePostedAt ||
    post.analysisResultJson !== event.rawExtractionJson ||
    post.analysisRevision !== (post.sourceRevision ?? 1) ||
    post.analysisContractVersion !== "event_evidence_v2" ||
    post.analysisIsEvent !== true ||
    !post.analysisModel?.startsWith("gpt-5-mini")
  ) {
    throw new Error("Event no longer matches the current saved GPT source analysis.");
  }

  const topology = await sourceOccurrenceProvenanceRepository
    .loadAndAssertEventOccurrenceTopology(ctx, event._id);
  const links = topology.links;
  const primaryLinks = links.filter((link) =>
    link.instagramPostId === postId &&
    canonicalizeSourceUrlOrEmpty("instagram", link.instagramPostUrl) ===
      eventPostUrl &&
    (!link.sourceHandle || normalizeHandle(link.sourceHandle) === sourceHandle) &&
    link.sourceOccurrenceKey === event.sourceOccurrenceKey &&
    link.sourceFingerprint === fields.sourceOccurrenceSourceFingerprint,
  );
  const link = primaryLinks.length === 1 ? primaryLinks[0] : null;
  if (
    links.length < 1 ||
    links.length > 3 ||
    !link ||
    requireCanonicalInstagramPostUrl(
      link.instagramPostUrl,
      "Source-bound venue repair source link",
    ) !== eventPostUrl
  ) {
    throw new Error("Event source link and receipt topology are not exact.");
  }

  if (links.length > 1) {
    if (
      adaptInstagramScrapedPostToSourceDocument(post).sourceIdentity !==
        link.sourceIdentity ||
      buildInstagramSourceOccurrenceFingerprint(post) !==
        link.sourceFingerprint
    ) {
      throw new Error("Primary multi-source link no longer matches its current saved post.");
    }
    const secondaryClaims: string[] = [];
    for (const secondary of links) {
      if (secondary._id === link._id) continue;
      const identity = secondary.sourceIdentity.match(
        /^instagram-source-identity-v1:([A-Za-z0-9_-]{1,64})$/u,
      );
      if (
        !identity ||
        secondary.instagramPostId !== postId ||
        requireCanonicalInstagramPostUrl(
          secondary.instagramPostUrl,
          "Source-bound venue repair secondary link",
        ) !== eventPostUrl ||
        (secondary.sourceHandle &&
          normalizeHandle(secondary.sourceHandle) !== sourceHandle)
      ) {
        throw new Error("Secondary source link no longer belongs to the canonical venue event.");
      }
      const canonicalSourceUrl = `https://www.instagram.com/p/${identity[1]}/`;
      const sourcePosts = await ctx.db
        .query("scrapedPosts")
        .withIndex("by_canonicalSourceUrl", (q) =>
          q.eq("canonicalSourceUrl", canonicalSourceUrl),
        )
        .take(2);
      const secondaryPost = sourcePosts.length === 1 ? sourcePosts[0] : null;
      const claims = secondaryPost
        ? currentSecondarySourceVenueClaimsForTesting(
            secondaryPost,
            secondary,
            sourceHandle,
          )
        : null;
      if (!claims) {
        throw new Error("Secondary source post lacks exact current venue evidence.");
      }
      secondaryClaims.push(...claims);
    }
    const uniqueSecondaryClaims = [...new Set(secondaryClaims)];
    if (uniqueSecondaryClaims.length > 16) {
      throw new Error("Secondary source venue claims exceed the safe repair bound.");
    }
    const secondaryResolutions = await resolveVenueClaimsForWrite(
      ctx,
      uniqueSecondaryClaims,
    );
    if (uniqueSecondaryClaims.some((claim) => {
      const resolved = secondaryResolutions.get(claim);
      return resolved?.resolution.status !== "resolved" ||
        resolved.venueFields.venueId !== venue._id ||
        resolved.canonicalVenueName !== venue.name;
    })) {
      throw new Error("A secondary source venue claim is ambiguous or offsite.");
    }
  }

  const normalizedFieldsJson = JSON.stringify({
    ...fields,
    normalizedVenue: venue.name,
  });
  const effectiveEvent = {
    ...event,
    ...canonical.venueFields,
    venue: venue.name,
    normalizedFieldsJson,
  };
  const isV2Auto = hasEventEvidenceV2AutoApproval(
    normalizedFieldsJson,
    effectiveEvent,
    { requireFutureDate: false },
  );
  const isUniqueAuto = hasAutomaticUniqueStructuredSourceAttestation(
    normalizedFieldsJson,
    effectiveEvent,
  );
  if (!isV2Auto && !isUniqueAuto) {
    throw new Error("Repaired venue would not retain the original auto-approval attestation.");
  }
  if (isV2Auto) await assertPersistedServiceSourcePolicy(ctx, effectiveEvent);
  await assertApprovalCandidatePolicy(ctx, effectiveEvent, [event._id]);

  const { affectedRepresentativeIds, topologyMutated } =
    await rebindCanonicalVenueProvenance(ctx, event, effectiveEvent);
  if (topologyMutated) {
    await markSourceOccurrenceTopologyMutation(ctx, { verified: true });
  }
  const updatedAt = nextEventUpdatedAt(event.updatedAt);
  await ctx.db.patch(event._id, {
    ...canonical.venueFields,
    venue: venue.name,
    normalizedFieldsJson,
    ...buildEventOccurrenceIndexPatch(effectiveEvent),
    updatedAt,
  });
  const repaired = await ctx.db.get(event._id);
  if (!repaired || !(await isCanonicallyGroundedApprovedEvent(ctx, repaired))) {
    throw new Error("Repaired event does not pass current public source grounding.");
  }
  await refreshCanonicalEventDerivedStates(ctx, affectedRepresentativeIds);
  await writeEventAuditLog(ctx, event._id, "source_bound_empty_v2_venue_repaired", {
    actor,
    note: args.moderationNote.trim(),
    patch: {
      venueId: venue._id,
      venue: venue.name,
      sourceHandle,
      sourcePostId: postId,
      approvalRule: fields.moderationAutoApproveRule,
    },
  });
  return { updated: true, updatedAt, status: event.status };
}
