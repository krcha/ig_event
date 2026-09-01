import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { DomainError } from "../../lib/domain/errors";
import { classifyApprovalOccurrenceRelation } from "../../lib/events/approval-occurrence-conflict";
import { isCaptionSourceCoherentWithEvent } from "../../lib/events/event-source-approval";
import { isSensibleEventTitleForApproval } from "../../lib/events/event-title-approval";
import {
  HUMAN_REVIEWED_LEGACY_SOURCE_POLICY_VERSION,
  HUMAN_REVIEWED_STRUCTURED_SOURCE_POLICY_VERSION,
  hasCompleteSourceGroundingAttestation,
  hasEventEvidenceV2AutoApproval,
  hasHumanReviewableLegacySourceAttestation,
  hasHumanReviewableStructuredSourceAttestation,
} from "../../lib/events/event-update-precondition";
import { normalizeInstagramPostUrl } from "../../lib/images/apify-images";
import { canonicalizeSourceUrl } from "../../lib/domain/source-url";
import {
  normalizeHandle,
  toSearchableText,
} from "../../lib/pipeline/venue-normalization";

const MAX_APPROVAL_DATE_COHORT_SIZE = 500;

export function normalizeLookup(value: string): string {
  return toSearchableText(value).replace(/\s+/g, " ").trim();
}

export function normalizeSourceCaption(value: string | undefined): string {
  return value?.normalize("NFKC").replace(/\s+/gu, " ").trim() ?? "";
}

export type ApprovalCandidateFields = {
  title: string;
  date: string;
  venue: string;
  venueId?: Id<"venues">;
  venueInstagramHandle?: string;
  instagramPostId?: string;
  instagramPostUrl?: string;
  time?: string;
  artists?: string[];
  sourceOccurrenceKey?: string;
  normalizedFieldsJson?: string;
  timeEvidenceKind?:
    | "start_time_stated"
    | "not_stated"
    | "unreadable"
    | "doors_open_only";
  dateEvidenceText?: string;
  dateEvidenceSource?: "caption" | "poster" | "alt_text" | "unknown";
  dateEvidenceIsRelative?: boolean;
  dateEvidenceResolvedDate?: string;
  sourceConflictFields?: string[];
  imageUrl?: string;
  imageStorageId?: Id<"_storage">;
};

export type ServiceSourceCandidateFields = ApprovalCandidateFields & {
  sourceCaption?: string;
  sourcePostedAt?: string;
  rawExtractionJson?: string;
};

export async function assertPersistedServiceSourcePolicy(
  ctx: QueryCtx | MutationCtx,
  candidate: ServiceSourceCandidateFields,
  options: {
    allowHumanReviewedLegacy?: boolean;
    allowHumanReviewedStructured?: boolean;
  } = {},
): Promise<void> {
  const structuredEvidence = hasEventEvidenceV2AutoApproval(
    candidate.normalizedFieldsJson,
    candidate,
  );
  const humanReviewedLegacy =
    options.allowHumanReviewedLegacy === true &&
    hasHumanReviewableLegacySourceAttestation(
      candidate.normalizedFieldsJson,
      candidate,
    );
  const humanReviewedStructured =
    options.allowHumanReviewedStructured === true &&
    hasHumanReviewableStructuredSourceAttestation(
      candidate.normalizedFieldsJson,
      candidate,
    );
  let structuredSourceHandle = "";
  let structuredExtractionMode = "";
  if (structuredEvidence || humanReviewedLegacy || humanReviewedStructured) {
    try {
      const fields = JSON.parse(
        candidate.normalizedFieldsJson ?? "{}",
      ) as Record<string, unknown>;
      structuredSourceHandle =
        typeof fields.sourceGroundingInstagramHandle === "string"
          ? normalizeHandle(fields.sourceGroundingInstagramHandle)
          : "";
      structuredExtractionMode =
        typeof fields.extractionMode === "string"
          ? fields.extractionMode.trim()
          : "";
    } catch {
      structuredSourceHandle = "";
      structuredExtractionMode = "";
    }
  }
  const handle =
    structuredSourceHandle ||
    normalizeHandle(candidate.venueInstagramHandle ?? "");
  const postId = candidate.instagramPostId?.trim() ?? "";
  const canonicalPostUrl = canonicalizeSourceUrl(
    "instagram",
    candidate.instagramPostUrl,
  );
  const postUrl = canonicalPostUrl.ok
    ? canonicalPostUrl.value.canonicalUrl
    : "";
  const sourceCaption = normalizeSourceCaption(candidate.sourceCaption);
  if (
    !handle ||
    !postId ||
    !canonicalPostUrl.ok ||
    !candidate.sourcePostedAt ||
    (!structuredEvidence && !sourceCaption)
  ) {
    throw new Error(
      "Service approval requires a persisted Instagram source post.",
    );
  }
  const persistedCandidates = await ctx.db
    .query("scrapedPosts")
    .withIndex("by_handle_postId", (q) =>
      q.eq("handle", handle).eq("postId", postId),
    )
    .take(2);
  const persisted =
    persistedCandidates.length === 1 ? persistedCandidates[0] : null;
  if (
    !persisted ||
    normalizeHandle(persisted.handle) !== handle ||
    normalizeHandle(persisted.username) !== handle ||
    persisted.postId !== postId ||
    canonicalizeSourceUrl("instagram", persisted.instagramPostUrl).ok !==
      true ||
    normalizeInstagramPostUrl(persisted.instagramPostUrl) !== postUrl ||
    normalizeSourceCaption(persisted.caption) !== sourceCaption ||
    persisted.postedAt !== candidate.sourcePostedAt
  ) {
    throw new Error(
      "Service approval source does not match the persisted Instagram post.",
    );
  }
  if (structuredEvidence || humanReviewedStructured) {
    const posterAssets =
      structuredExtractionMode === "poster"
        ? await ctx.db
            .query("mediaAssets")
            .withIndex("by_sourceKey", (q) =>
              q.eq("sourceKey", `instagram-post:${postId}`),
            )
            .take(2)
        : [];
    const posterAsset = posterAssets.length === 1 ? posterAssets[0] : null;
    if (
      !candidate.rawExtractionJson ||
      candidate.rawExtractionJson !== persisted.analysisResultJson ||
      persisted.analysisRevision !== (persisted.sourceRevision ?? 1) ||
      persisted.analysisContractVersion !== "event_evidence_v2" ||
      persisted.analysisIsEvent !== true ||
      !persisted.analysisModel?.startsWith("gpt-5-mini") ||
      candidate.sourcePostedAt !== persisted.postedAt ||
      (structuredExtractionMode === "poster" &&
        (!persisted.analysisImageSourceUrl ||
          !persisted.analysisImageChecksumSha256 ||
          !persisted.imageStorageId ||
          !posterAsset ||
          posterAsset.storageId !== persisted.imageStorageId ||
          posterAsset.checksumSha256 !==
            persisted.analysisImageChecksumSha256 ||
          ((candidate.imageUrl !== undefined ||
            candidate.imageStorageId !== undefined) &&
            (candidate.imageUrl !== posterAsset.url ||
              candidate.imageStorageId !== posterAsset.storageId))))
    ) {
      throw new Error(
        "Service approval requires current persisted GPT-5 mini event evidence bound to the exact source revision.",
      );
    }
    return;
  }
  if (humanReviewedLegacy) return;
  if (
    !isCaptionSourceCoherentWithEvent({
      title: candidate.title,
      date: candidate.date,
      time: candidate.time,
      venue: candidate.venue,
      artists: candidate.artists ?? [],
      sourceCaption: persisted.caption,
      sourcePostedAt: persisted.postedAt,
      instagramPostId: persisted.postId,
      instagramPostUrl: persisted.instagramPostUrl,
      sourceInstagramHandle: persisted.handle,
      venueInstagramHandle: candidate.venueInstagramHandle,
    })
  ) {
    throw new Error(
      "Service approval source does not independently ground the final public event fields.",
    );
  }
}

export async function assertHumanApprovalSourcePolicy(
  ctx: QueryCtx | MutationCtx,
  candidate: ServiceSourceCandidateFields & { imageUrl?: string },
  moderationNote: string | undefined,
): Promise<{
  normalizedFieldsJson?: string;
  humanReviewedLegacySourcePolicyVersion?: typeof HUMAN_REVIEWED_LEGACY_SOURCE_POLICY_VERSION;
  humanReviewedStructuredSourcePolicyVersion?: typeof HUMAN_REVIEWED_STRUCTURED_SOURCE_POLICY_VERSION;
}> {
  const completeMachineAttestation = hasCompleteSourceGroundingAttestation(
    candidate.normalizedFieldsJson,
    candidate,
  );
  const humanReviewableLegacy = hasHumanReviewableLegacySourceAttestation(
    candidate.normalizedFieldsJson,
    candidate,
  );
  const humanReviewableStructured =
    hasHumanReviewableStructuredSourceAttestation(
      candidate.normalizedFieldsJson,
      candidate,
    );
  if (
    !completeMachineAttestation &&
    !humanReviewableLegacy &&
    !humanReviewableStructured
  ) {
    throw new Error(
      "Human approval requires complete canonical Instagram source grounding for the final public fields.",
    );
  }
  if (
    (humanReviewableLegacy || humanReviewableStructured) &&
    (moderationNote?.trim().length ?? 0) < 20
  ) {
    throw new Error("Human approval requires a substantive moderation note.");
  }
  await assertPersistedServiceSourcePolicy(ctx, candidate, {
    allowHumanReviewedLegacy: humanReviewableLegacy,
    allowHumanReviewedStructured: humanReviewableStructured,
  });
  if (!humanReviewableLegacy && !humanReviewableStructured) return {};
  const normalizedFields = JSON.parse(
    candidate.normalizedFieldsJson ?? "{}",
  ) as Record<string, unknown>;
  const marker: {
    humanReviewedLegacySourcePolicyVersion?: typeof HUMAN_REVIEWED_LEGACY_SOURCE_POLICY_VERSION;
    humanReviewedStructuredSourcePolicyVersion?: typeof HUMAN_REVIEWED_STRUCTURED_SOURCE_POLICY_VERSION;
  } = humanReviewableStructured
    ? {
        humanReviewedStructuredSourcePolicyVersion:
          HUMAN_REVIEWED_STRUCTURED_SOURCE_POLICY_VERSION,
      }
    : {
        humanReviewedLegacySourcePolicyVersion:
          HUMAN_REVIEWED_LEGACY_SOURCE_POLICY_VERSION,
      };
  return {
    ...marker,
    normalizedFieldsJson: JSON.stringify({ ...normalizedFields, ...marker }),
  };
}

function approvalCandidatesShareVenue(
  left: ApprovalCandidateFields,
  right: ApprovalCandidateFields,
): boolean {
  const leftVenue = normalizeLookup(left.venue);
  return (
    (left.venueId !== undefined &&
      right.venueId !== undefined &&
      left.venueId === right.venueId) ||
    (Boolean(left.venueInstagramHandle) &&
      normalizeHandle(left.venueInstagramHandle ?? "") ===
        normalizeHandle(right.venueInstagramHandle ?? "")) ||
    (Boolean(leftVenue) && leftVenue === normalizeLookup(right.venue))
  );
}

function approvalCandidateHasKnownVenue(
  candidate: ApprovalCandidateFields,
): boolean {
  return (
    candidate.venueId !== undefined ||
    Boolean(normalizeHandle(candidate.venueInstagramHandle ?? "")) ||
    Boolean(normalizeLookup(candidate.venue))
  );
}

function approvalCandidatesShareSource(
  left: ApprovalCandidateFields,
  right: ApprovalCandidateFields,
): boolean {
  const leftPostId = left.instagramPostId?.trim() ?? "";
  const leftPostUrl = normalizeLookup(left.instagramPostUrl ?? "");
  return (
    (Boolean(leftPostId) && leftPostId === right.instagramPostId?.trim()) ||
    (Boolean(leftPostUrl) &&
      leftPostUrl === normalizeLookup(right.instagramPostUrl ?? ""))
  );
}

export function classifyApprovalCandidates(
  left: ApprovalCandidateFields,
  right: ApprovalCandidateFields,
) {
  if (left.date !== right.date) return "unrelated" as const;
  return classifyApprovalOccurrenceRelation({
    candidate: left,
    existing: right,
    sameVenue: approvalCandidatesShareVenue(left, right),
    sameSource: approvalCandidatesShareSource(left, right),
    unknownVenue:
      !approvalCandidateHasKnownVenue(left) ||
      !approvalCandidateHasKnownVenue(right),
  });
}

export function assertPairwiseOccurrenceRelation(
  candidates: ApprovalCandidateFields[],
  expected: "proven_distinct" | "proven_duplicate",
  message: string,
): void {
  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < candidates.length;
      rightIndex += 1
    ) {
      if (
        classifyApprovalCandidates(
          candidates[leftIndex],
          candidates[rightIndex],
        ) !== expected
      ) {
        throw new Error(message);
      }
    }
  }
}

export async function assertApprovalCandidatePolicy(
  ctx: MutationCtx,
  candidate: ApprovalCandidateFields,
  excludeEventIds: Id<"events">[] = [],
  options: {
    expectedAmbiguousApprovedEventVersions?: Array<{
      id: Id<"events">;
      updatedAt: number;
    }>;
  } = {},
): Promise<void> {
  if (!isSensibleEventTitleForApproval(candidate)) {
    throw new DomainError(
      "MODERATION_INELIGIBLE",
      "Event title is not suitable for approval.",
    );
  }
  const sameDateEvents = await ctx.db
    .query("events")
    .withIndex("by_status_date", (q) =>
      q.eq("status", "approved").eq("date", candidate.date),
    )
    .take(MAX_APPROVAL_DATE_COHORT_SIZE + 1);
  if (sameDateEvents.length > MAX_APPROVAL_DATE_COHORT_SIZE) {
    throw new Error("Approved same-date cohort exceeds the safe review bound.");
  }
  const candidateVenue = normalizeLookup(candidate.venue);
  const candidatePostUrl = normalizeLookup(candidate.instagramPostUrl ?? "");
  const candidatePostId = candidate.instagramPostId?.trim() ?? "";
  const excluded = new Set(excludeEventIds);
  const expectedAmbiguousVersions =
    options.expectedAmbiguousApprovedEventVersions ?? [];
  if (
    expectedAmbiguousVersions.length > 8 ||
    new Set(expectedAmbiguousVersions.map((row) => row.id)).size !==
      expectedAmbiguousVersions.length ||
    expectedAmbiguousVersions.some(
      (row) => !Number.isSafeInteger(row.updatedAt) || excluded.has(row.id),
    )
  ) {
    throw new Error("Reviewed ambiguous occurrence versions are invalid.");
  }
  const expectedAmbiguousById = new Map(
    expectedAmbiguousVersions.map((row) => [row.id, row.updatedAt] as const),
  );
  const matchedAmbiguousIds = new Set<Id<"events">>();
  let ambiguousConflict = false;
  for (const event of sameDateEvents) {
    if (excluded.has(event._id)) continue;
    const sameVenue =
      (candidate.venueId !== undefined &&
        event.venueId !== undefined &&
        event.venueId === candidate.venueId) ||
      (Boolean(candidate.venueInstagramHandle) &&
        normalizeHandle(event.venueInstagramHandle ?? "") ===
          normalizeHandle(candidate.venueInstagramHandle ?? "")) ||
      (Boolean(candidateVenue) &&
        normalizeLookup(event.venue) === candidateVenue);
    const sameSourceEvent =
      (Boolean(candidatePostId) &&
        event.instagramPostId?.trim() === candidatePostId) ||
      (Boolean(candidatePostUrl) &&
        normalizeLookup(event.instagramPostUrl ?? "") === candidatePostUrl);
    const relation = classifyApprovalOccurrenceRelation({
      candidate,
      existing: event,
      sameVenue,
      sameSource: sameSourceEvent,
      unknownVenue:
        !approvalCandidateHasKnownVenue(candidate) ||
        !approvalCandidateHasKnownVenue(event),
    });
    if (relation === "proven_duplicate") {
      throw new DomainError(
        "EVENT_DUPLICATE",
        "An approved event already exists for this canonical occurrence.",
      );
    }
    if (relation === "ambiguous") {
      const expectedUpdatedAt = expectedAmbiguousById.get(event._id);
      if (expectedUpdatedAt === undefined) ambiguousConflict = true;
      else if (event.updatedAt !== expectedUpdatedAt) {
        throw new Error(
          "A reviewed ambiguous approved event changed before correction.",
        );
      } else matchedAmbiguousIds.add(event._id);
    }
  }
  if (matchedAmbiguousIds.size !== expectedAmbiguousById.size) {
    throw new Error(
      "The reviewed ambiguous approved event set changed before correction.",
    );
  }
  if (ambiguousConflict) {
    throw new DomainError(
      "EVENT_AMBIGUOUS",
      "This same-day occurrence is ambiguous against an approved event and cannot be auto-approved.",
    );
  }
}
