import { createHash } from "node:crypto";
import type { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import { getBelgradeDayKey } from "../pipeline/belgrade-day-key";
import { canonicalizeEventType } from "../taxonomy/venue-types";
import {
  buildCrossPostPromotionCoalescingPlan,
  deriveAutomaticCrossPostCampaignIdentity,
  deriveExclusiveHashtagCrossPostCampaignIdentity,
  deriveCrossPostPromotionSharedEvidenceAnchors,
  hasAutomaticCrossPostCanonicalVenueEvidence,
  MAX_AUTOMATIC_CROSS_POST_SOURCE_HISTORY,
  type CrossPostCampaignHistoryPost,
  type CrossPostPromotionCandidate,
} from "./cross-post-promotion-coalescing";
import {
  isCrossPostCampaignLineageEvent,
  readCrossPostCampaignAggregateAttestation,
  type CrossPostCampaignAggregateAttestation,
} from "./cross-post-campaign-aggregate-attestation";

const listByStatusQuery =
  "events:listByStatusPaginated" as unknown as FunctionReference<"query">;
const crossPostContextQuery =
  "events:getCrossPostPromotionCoalescingContext" as unknown as FunctionReference<"query">;
const crossPostCoalescingMutation =
  "events:coalesceApprovedCrossPostPromotionOccurrences" as unknown as FunctionReference<"mutation">;
const listScrapedPostsByHandleQuery =
  "scrapedPosts:listByHandlePaginated" as unknown as FunctionReference<"query">;
const listPublicVenueFieldsQuery =
  "venues:listPublicVenueFields" as unknown as FunctionReference<"query">;

const MAX_APPROVED_SCAN = 5_000;
const APPROVED_PAGE_SIZE = 50;
const MAX_CAMPAIGN_CANDIDATES = 8;
const MAX_CAMPAIGN_GROUPS_PER_RUN = 32;
const AUTOMATIC_EVENT_TYPES = new Set(["nightlife", "live music"]);

export type ApprovedCrossPostCampaignSourceEvent = {
  _id: string;
  title: string;
  date: string;
  time?: string;
  timeStatus?: string;
  timeEvidenceKind?: string;
  timeConfidence?: number;
  venue: string;
  venueId?: string;
  venueInstagramHandle?: string;
  artists: string[];
  description?: string;
  imageUrl?: string;
  imageStorageId?: string;
  instagramPostUrl?: string;
  instagramPostId?: string;
  ticketPrice?: string;
  eventType: string;
  sourceCaption?: string;
  sourcePostedAt?: string;
  normalizedFieldsJson?: string;
  sourceOccurrenceKey?: string;
  sourceConflictFields?: string[];
  status?: "pending" | "approved" | "rejected";
  createdAt: number;
  updatedAt: number;
};

export type ApprovedCrossPostCampaignCohort = {
  cohortKey: string;
  sourceHandle: string;
  targetVenueId: string;
  date: string;
  time: string;
  eventType: string;
  events: ApprovedCrossPostCampaignSourceEvent[];
  existingAggregate?: CrossPostCampaignAggregateAttestation;
};

export type ApprovedCrossPostCanonicalVenue = {
  _id: string;
  name: string;
  instagramHandle: string;
};

export type ApprovedCrossPostCampaignSkip = {
  eventIds: string[];
  reason: string;
};

export type ApprovedCrossPostCampaignFailure = {
  eventIds: string[];
  error: string;
};

export type ApprovedCrossPostCampaignAutoCoalesceSummary = {
  scannedEventCount: number;
  candidateGroupCount: number;
  coalescedGroupCount: number;
  foldedVariantCount: number;
  alreadyCoalescedGroupCount: number;
  skippedGroupCount: number;
  skipped: ApprovedCrossPostCampaignSkip[];
  failedCount: number;
  failures: ApprovedCrossPostCampaignFailure[];
  error?: string;
};

type CrossPostContextCandidate = {
  event: ApprovedCrossPostCampaignSourceEvent & {
    normalizedFieldsJson: string;
    sourceOccurrenceKey: string;
  };
  sourceLink: {
    _id: string;
    updatedAt: number;
    sourceIdentity: string;
    sourceFingerprint: string;
    sourceOccurrenceKey: string;
    sourceHandle?: string;
  };
  receipt: { _id: string; updatedAt: number };
};

type CrossPostContext = {
  state: "ready" | "already_coalesced";
  targetVenue: {
    _id: string;
    name: string;
    instagramHandle: string;
    updatedAt: number;
  };
  candidates: CrossPostContextCandidate[];
};

function parseObject(value: string | undefined): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function normalizeHandle(value: string | undefined): string {
  return value?.normalize("NFKC").trim().replace(/^@+/, "").toLowerCase() ?? "";
}

function exactReliableCandidate(
  event: ApprovedCrossPostCampaignSourceEvent,
  today: string,
): { sourceHandle: string; eventType: string } | null {
  const fields = parseObject(event.normalizedFieldsJson);
  const sourceHandle = normalizeHandle(
    typeof fields?.sourceGroundingInstagramHandle === "string"
      ? fields.sourceGroundingInstagramHandle
      : undefined,
  );
  const eventType = canonicalizeEventType(event.eventType);
  if (
    (isCrossPostCampaignLineageEvent(event) &&
      !readCrossPostCampaignAggregateAttestation(event.normalizedFieldsJson)) ||
    event.status !== "approved" ||
    event.date < today ||
    !/^\d{4}-\d{2}-\d{2}$/.test(event.date) ||
    !sourceHandle ||
    !event.time ||
    !/^\d{2}:\d{2}$/.test(event.time) ||
    event.timeStatus !== "confirmed" ||
    event.timeEvidenceKind !== "start_time_stated" ||
    !Number.isFinite(event.timeConfidence) ||
    (event.timeConfidence as number) < 0.8 ||
    fields?.dateEvidenceVerified !== true ||
    fields?.timeEvidenceVerified !== true ||
    !AUTOMATIC_EVENT_TYPES.has(eventType) ||
    (event.sourceConflictFields?.length ?? 0) !== 0 ||
    !event.sourceCaption?.trim() ||
    !event.instagramPostId?.trim() ||
    !event.instagramPostUrl?.trim() ||
    !event.sourceOccurrenceKey?.trim()
  ) {
    return null;
  }
  return { sourceHandle, eventType };
}

function primaryStrength(event: ApprovedCrossPostCampaignSourceEvent): number {
  return (
    (event.imageStorageId && event.imageUrl ? 1_000_000 : 0) +
    event.artists.length * 10_000 +
    Math.min(event.description?.length ?? 0, 5_000) * 10 +
    Math.min(event.title.length, 500)
  );
}

function orderCampaignEvents(
  events: ApprovedCrossPostCampaignSourceEvent[],
  targetVenue?: ApprovedCrossPostCanonicalVenue,
): ApprovedCrossPostCampaignSourceEvent[] {
  return [...events].sort(
    (left, right) =>
      (targetVenue && exactPersistedTargetVenueBinding(right, targetVenue) ? 1 : 0) -
        (targetVenue && exactPersistedTargetVenueBinding(left, targetVenue) ? 1 : 0) ||
      primaryStrength(right) - primaryStrength(left) ||
      left.createdAt - right.createdAt ||
      left._id.localeCompare(right._id),
  );
}

function exactPersistedTargetVenueBinding(
  event: ApprovedCrossPostCampaignSourceEvent,
  targetVenue: ApprovedCrossPostCanonicalVenue,
): boolean {
  return (
    event.venueId === targetVenue._id &&
    event.venue.normalize("NFKC").trim() === targetVenue.name.normalize("NFKC").trim() &&
    normalizeHandle(event.venueInstagramHandle) ===
      normalizeHandle(targetVenue.instagramHandle)
  );
}

function hasAutomaticTargetVenueEvidence(
  event: ApprovedCrossPostCampaignSourceEvent,
  sourceHandle: string,
  targetVenue: ApprovedCrossPostCanonicalVenue,
): boolean {
  return hasAutomaticCrossPostCanonicalVenueEvidence({
    evidenceText: event.sourceCaption ?? "",
    sourceHandle,
    targetVenueId: targetVenue._id,
    canonicalVenueName: targetVenue.name,
    canonicalVenueHandle: targetVenue.instagramHandle,
    currentVenueId: event.venueId,
    currentVenueName: event.venue,
    currentVenueHandle: event.venueInstagramHandle,
  });
}

export function buildApprovedCrossPostCampaignCohorts(
  events: ApprovedCrossPostCampaignSourceEvent[],
  options?: {
    today?: string;
    venues?: ApprovedCrossPostCanonicalVenue[];
  },
): { cohorts: ApprovedCrossPostCampaignCohort[]; skipped: ApprovedCrossPostCampaignSkip[] } {
  const today = options?.today ?? getBelgradeDayKey();
  const byKey = new Map<string, ApprovedCrossPostCampaignSourceEvent[]>();
  for (const event of events) {
    const exact = exactReliableCandidate(event, today);
    if (!exact) continue;
    const evidenceMatchedVenues = options?.venues?.filter((venue) =>
      hasAutomaticTargetVenueEvidence(event, exact.sourceHandle, venue),
    );
    const targetVenueId = options?.venues
      ? evidenceMatchedVenues?.length === 1
        ? evidenceMatchedVenues[0]!._id
        : null
      : event.venueId?.trim() || null;
    if (!targetVenueId) continue;
    const key = JSON.stringify([
      exact.sourceHandle,
      targetVenueId,
      event.date,
      event.time,
      exact.eventType,
    ]);
    const group = byKey.get(key) ?? [];
    group.push(event);
    byKey.set(key, group);
  }

  const cohorts: ApprovedCrossPostCampaignCohort[] = [];
  const skipped: ApprovedCrossPostCampaignSkip[] = [];
  for (const [cohortKey, group] of [...byKey.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (group.length < 2) continue;
    const [, targetVenueId] = JSON.parse(cohortKey) as string[];
    const targetVenue = options?.venues?.find(
      (venue) => venue._id === targetVenueId,
    );
    if (
      options?.venues &&
      (!targetVenue ||
        !group.some((event) => exactPersistedTargetVenueBinding(event, targetVenue)))
    ) {
      skipped.push({
        eventIds: group.map((event) => event._id),
        reason: "campaign_cohort_has_no_exact_target_primary",
      });
      continue;
    }
    let ordered = orderCampaignEvents(group, targetVenue);
    const aggregateCandidates = ordered
      .map((event) => ({
        event,
        attestation: readCrossPostCampaignAggregateAttestation(
          event.normalizedFieldsJson,
        ),
      }))
      .filter(
        (candidate): candidate is {
          event: ApprovedCrossPostCampaignSourceEvent;
          attestation: CrossPostCampaignAggregateAttestation;
        } => candidate.attestation !== null,
      );
    if (aggregateCandidates.length > 1) {
      skipped.push({
        eventIds: ordered.map((event) => event._id),
        reason: "campaign_cohort_has_multiple_existing_aggregates",
      });
      continue;
    }
    const existingAggregate = aggregateCandidates[0];
    if (existingAggregate) {
      if (
        existingAggregate.attestation.primaryEventId !== existingAggregate.event._id ||
        !existingAggregate.attestation.automaticCampaignIdentity ||
        existingAggregate.attestation.totalSourceCount + group.length - 1 >
          MAX_CAMPAIGN_CANDIDATES
      ) {
        skipped.push({
          eventIds: ordered.map((event) => event._id),
          reason: "campaign_existing_aggregate_not_appendable",
        });
        continue;
      }
      ordered = [
        existingAggregate.event,
        ...ordered.filter((event) => event._id !== existingAggregate.event._id),
      ];
    }
    const identities = [
      ordered.map((event) => event._id),
      ordered.map((event) => event.instagramPostId),
      ordered.map((event) => event.instagramPostUrl),
      ordered.map((event) => event.sourceOccurrenceKey),
    ];
    if (
      group.length > MAX_CAMPAIGN_CANDIDATES ||
      identities.some(
        (values) => values.some((value) => !value) || new Set(values).size !== values.length,
      )
    ) {
      skipped.push({
        eventIds: ordered.map((event) => event._id),
        reason:
          group.length > MAX_CAMPAIGN_CANDIDATES
            ? "campaign_cohort_exceeds_safe_bound"
            : "campaign_cohort_source_lineage_not_unique",
      });
      continue;
    }
    const [sourceHandle, parsedTargetVenueId, date, time, eventType] = JSON.parse(
      cohortKey,
    ) as string[];
    cohorts.push({
      cohortKey,
      sourceHandle: sourceHandle!,
      targetVenueId: parsedTargetVenueId!,
      date: date!,
      time: time!,
      eventType: eventType!,
      events: ordered,
      ...(existingAggregate
        ? { existingAggregate: existingAggregate.attestation }
        : {}),
    });
  }
  return { cohorts, skipped };
}

function operationIdForCohort(cohort: ApprovedCrossPostCampaignCohort): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        policy: 1,
        cohortKey: cohort.cohortKey,
        eventIds: cohort.events.map((event) => event._id).sort(),
      }),
    )
    .digest("hex")
    .slice(0, 40);
  return `auto-cross-post-v1:${digest}`;
}

function mapContextCandidate(candidate: CrossPostContextCandidate): CrossPostPromotionCandidate {
  const fields = parseObject(candidate.event.normalizedFieldsJson) ?? {};
  return {
    id: candidate.event._id,
    sourceHandle:
      candidate.sourceLink.sourceHandle ??
      (typeof fields.sourceGroundingInstagramHandle === "string"
        ? fields.sourceGroundingInstagramHandle
        : ""),
    sourceIdentity: candidate.sourceLink.sourceIdentity,
    sourceOccurrenceKey: candidate.sourceLink.sourceOccurrenceKey,
    instagramPostId: candidate.event.instagramPostId ?? "",
    instagramPostUrl: candidate.event.instagramPostUrl ?? "",
    title: candidate.event.title,
    date: candidate.event.date,
    time: candidate.event.time,
    timeStatus: candidate.event.timeStatus,
    timeEvidenceKind: candidate.event.timeEvidenceKind,
    timeConfidence: candidate.event.timeConfidence,
    dateEvidenceVerified: fields.dateEvidenceVerified === true,
    timeEvidenceVerified: fields.timeEvidenceVerified === true,
    venueEvidenceText: candidate.event.sourceCaption ?? "",
    eventType: canonicalizeEventType(candidate.event.eventType),
    sourceConflictFields: candidate.event.sourceConflictFields ?? [],
    artists: candidate.event.artists,
    description: candidate.event.description,
    ticketPrice: candidate.event.ticketPrice,
    imageUrl: candidate.event.imageUrl,
    imageStorageId: candidate.event.imageStorageId,
  };
}

function candidateVersion(candidate: CrossPostContextCandidate) {
  return {
    id: candidate.event._id,
    expectedUpdatedAt: candidate.event.updatedAt,
    expectedNormalizedFieldsJson: candidate.event.normalizedFieldsJson,
    expectedSourceLinkId: candidate.sourceLink._id,
    expectedSourceLinkUpdatedAt: candidate.sourceLink.updatedAt,
    expectedSourceIdentity: candidate.sourceLink.sourceIdentity,
    expectedSourceFingerprint: candidate.sourceLink.sourceFingerprint,
    expectedOccurrenceKey: candidate.sourceLink.sourceOccurrenceKey,
    expectedReceiptId: candidate.receipt._id,
    expectedReceiptUpdatedAt: candidate.receipt.updatedAt,
  };
}

function freshContextMatchesScannedCohort(
  context: CrossPostContext,
  cohort: ApprovedCrossPostCampaignCohort,
): boolean {
  if (
    context.targetVenue._id !== cohort.targetVenueId ||
    context.candidates.length !== cohort.events.length
  ) {
    return false;
  }
  const freshAggregate = readCrossPostCampaignAggregateAttestation(
    context.candidates[0]?.event.normalizedFieldsJson,
  );
  if (
    JSON.stringify(freshAggregate) !==
    JSON.stringify(cohort.existingAggregate ?? null)
  ) {
    return false;
  }
  return context.candidates.every((candidate, index) => {
    const fields = parseObject(candidate.event.normalizedFieldsJson);
    return (
      candidate.event._id === cohort.events[index]?._id &&
      candidate.event.updatedAt === cohort.events[index]?.updatedAt &&
      candidate.event.status === "approved" &&
      candidate.event.venueId === cohort.events[index]?.venueId &&
      hasAutomaticTargetVenueEvidence(
        candidate.event,
        cohort.sourceHandle,
        context.targetVenue,
      ) &&
      candidate.event.date === cohort.date &&
      candidate.event.time === cohort.time &&
      candidate.event.timeStatus === "confirmed" &&
      candidate.event.timeEvidenceKind === "start_time_stated" &&
      Number.isFinite(candidate.event.timeConfidence) &&
      (candidate.event.timeConfidence as number) >= 0.8 &&
      canonicalizeEventType(candidate.event.eventType) === cohort.eventType &&
      fields?.dateEvidenceVerified === true &&
      fields?.timeEvidenceVerified === true &&
      (candidate.event.sourceConflictFields?.length ?? 0) === 0 &&
      normalizeHandle(
        typeof fields?.sourceGroundingInstagramHandle === "string"
          ? fields.sourceGroundingInstagramHandle
          : undefined,
      ) === cohort.sourceHandle &&
      normalizeHandle(
        candidate.sourceLink.sourceHandle ??
          (typeof fields?.sourceGroundingInstagramHandle === "string"
            ? fields.sourceGroundingInstagramHandle
            : undefined),
      ) === cohort.sourceHandle
    );
  });
}

function scannedCohortHasAutomaticCampaignProof(
  cohort: ApprovedCrossPostCampaignCohort,
): boolean {
  const captions = cohort.events.map((event) => event.sourceCaption ?? "");
  const automaticCampaignIdentity = deriveAutomaticCrossPostCampaignIdentity(captions);
  const anchors =
    cohort.existingAggregate?.campaignAnchors ??
    deriveCrossPostPromotionSharedEvidenceAnchors({
      captions,
      sourceHandle: cohort.sourceHandle,
      canonicalVenueName: cohort.events[0]?.venue ?? "",
      canonicalVenueHandle: cohort.events[0]?.venueInstagramHandle ?? "",
    });
  const hasExpectedUrlIdentity = Boolean(
    automaticCampaignIdentity &&
      automaticCampaignIdentity ===
        (cohort.existingAggregate?.automaticCampaignIdentity ??
          automaticCampaignIdentity),
  );
  const noUrlSourceCount = cohort.existingAggregate
    ? cohort.existingAggregate.totalSourceCount + cohort.events.length - 1
    : cohort.events.length;
  return Boolean(
    anchors &&
      (hasExpectedUrlIdentity ||
        (noUrlSourceCount >= 3 &&
          (!cohort.existingAggregate ||
            cohort.existingAggregate.automaticCampaignIdentity?.startsWith(
              "instagram-exclusive-hashtag-campaign-v1:",
            ) === true))),
  );
}

function isSafetyRefusal(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /arguments are invalid|requires one exact|neither ready|precondition failed|occurrence proof failed|must be individually source-grounded|primary occurrence must match|cannot satisfy variant receipt|canonical occurrence|is ambiguous/i.test(
    message,
  );
}

async function loadApprovedEvents(
  convex: ConvexHttpClient,
  serviceSecret: string,
): Promise<{ events: ApprovedCrossPostCampaignSourceEvent[]; complete: boolean }> {
  const events: ApprovedCrossPostCampaignSourceEvent[] = [];
  let cursor: string | null = null;
  while (events.length < MAX_APPROVED_SCAN) {
    const result = (await convex.query(listByStatusQuery, {
      status: "approved",
      paginationOpts: {
        cursor,
        numItems: Math.min(APPROVED_PAGE_SIZE, MAX_APPROVED_SCAN - events.length),
      },
      serviceSecret,
    })) as {
      page: ApprovedCrossPostCampaignSourceEvent[];
      isDone: boolean;
      continueCursor: string;
    };
    events.push(...result.page);
    if (result.isDone) return { events, complete: true };
    if (!result.continueCursor || result.continueCursor === cursor) {
      throw new Error("Cross-post campaign approved-event pagination did not advance.");
    }
    cursor = result.continueCursor;
  }
  return { events: events.slice(0, MAX_APPROVED_SCAN), complete: false };
}

async function loadPublicCanonicalVenues(
  convex: ConvexHttpClient,
): Promise<ApprovedCrossPostCanonicalVenue[]> {
  const venues = (await convex.query(listPublicVenueFieldsQuery, {
    limit: 2_000,
  })) as ApprovedCrossPostCanonicalVenue[];
  if (venues.length > 2_000) {
    throw new Error("Cross-post canonical venue scan exceeded the safe 2,000-row bound.");
  }
  return venues;
}

async function loadBoundedSourceHistory(
  convex: ConvexHttpClient,
  sourceHandle: string,
  serviceSecret: string,
): Promise<{ posts: CrossPostCampaignHistoryPost[]; complete: boolean }> {
  const posts: CrossPostCampaignHistoryPost[] = [];
  let cursor: string | null = null;
  while (posts.length < MAX_AUTOMATIC_CROSS_POST_SOURCE_HISTORY) {
    const result = (await convex.query(listScrapedPostsByHandleQuery, {
      handle: sourceHandle,
      paginationOpts: {
        cursor,
        numItems: Math.min(
          APPROVED_PAGE_SIZE,
          MAX_AUTOMATIC_CROSS_POST_SOURCE_HISTORY - posts.length,
        ),
      },
      serviceSecret,
    })) as {
      page: CrossPostCampaignHistoryPost[];
      isDone: boolean;
      continueCursor: string;
    };
    posts.push(...result.page);
    if (result.isDone) return { posts, complete: true };
    if (!result.continueCursor || result.continueCursor === cursor) {
      throw new Error("Cross-post source-history pagination did not advance.");
    }
    cursor = result.continueCursor;
  }
  return {
    posts: posts.slice(0, MAX_AUTOMATIC_CROSS_POST_SOURCE_HISTORY),
    complete: false,
  };
}

async function runCohort(
  convex: ConvexHttpClient,
  cohort: ApprovedCrossPostCampaignCohort,
  serviceSecret: string,
  mutationBudget: { attempted: number },
  sourceHistoryCache: Map<
    string,
    Promise<{ posts: CrossPostCampaignHistoryPost[]; complete: boolean }>
  >,
): Promise<
  | { state: "coalesced" | "already_coalesced"; foldedVariantCount: number }
  | { state: "skipped"; reason: string }
> {
  const operationId = operationIdForCohort(cohort);
  const eventIds = cohort.events.map((event) => event._id);
  let lastMutationError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let context: CrossPostContext;
    try {
      context = (await convex.query(crossPostContextQuery, {
        operationId,
        eventIds,
        targetVenueId: cohort.targetVenueId,
        serviceSecret,
      })) as CrossPostContext;
    } catch (error) {
      if (isSafetyRefusal(error)) {
        return {
          state: "skipped",
          reason: error instanceof Error ? error.message : "context safety refusal",
        };
      }
      throw error;
    }
    if (context.state === "already_coalesced") {
      return { state: "already_coalesced", foldedVariantCount: eventIds.length - 1 };
    }
    if (!freshContextMatchesScannedCohort(context, cohort)) {
      return { state: "skipped", reason: "fresh_context_cohort_mismatch" };
    }
    const captions = context.candidates.map(
      (candidate) => candidate.event.sourceCaption ?? "",
    );
    let automaticCampaignIdentity = deriveAutomaticCrossPostCampaignIdentity(captions);
    const anchors = cohort.existingAggregate?.campaignAnchors ??
      deriveCrossPostPromotionSharedEvidenceAnchors({
      captions,
      sourceHandle: cohort.sourceHandle,
      canonicalVenueName: context.targetVenue.name,
      canonicalVenueHandle: context.targetVenue.instagramHandle,
    });
    if (!automaticCampaignIdentity && anchors) {
      let sourceHistory = sourceHistoryCache.get(cohort.sourceHandle);
      if (!sourceHistory) {
        sourceHistory = loadBoundedSourceHistory(
          convex,
          cohort.sourceHandle,
          serviceSecret,
        );
        sourceHistoryCache.set(cohort.sourceHandle, sourceHistory);
      }
      const history = await sourceHistory;
      const candidatePostIds = cohort.existingAggregate
        ? [
            ...cohort.existingAggregate.campaignPostIds,
            ...context.candidates.slice(1).map((candidate) =>
              candidate.event.instagramPostId ?? "",
            ),
          ]
        : context.candidates.map((candidate) => candidate.event.instagramPostId ?? "");
      automaticCampaignIdentity = deriveExclusiveHashtagCrossPostCampaignIdentity({
        sourceHandle: cohort.sourceHandle,
        targetVenueId: cohort.targetVenueId,
        date: cohort.date,
        time: cohort.time,
        eventType: cohort.eventType,
        anchors,
        candidatePostIds,
        historyPosts: history.posts,
        historyComplete: history.complete,
      });
    }
    const plan = anchors
      ? buildCrossPostPromotionCoalescingPlan({
          candidates: context.candidates.map(mapContextCandidate),
          canonicalVenueName: context.targetVenue.name,
          canonicalVenueHandle: context.targetVenue.instagramHandle,
          sharedAnchors: anchors,
        })
      : null;
    if (
      !automaticCampaignIdentity ||
      automaticCampaignIdentity !==
        (cohort.existingAggregate?.automaticCampaignIdentity ??
          automaticCampaignIdentity) ||
      !anchors ||
      !plan ||
      plan.primaryId !== context.candidates[0]?.event._id
    ) {
      return { state: "skipped", reason: "shared_campaign_proof_insufficient" };
    }
    const versions = context.candidates.map(candidateVersion);
    if (mutationBudget.attempted >= MAX_CAMPAIGN_GROUPS_PER_RUN) {
      return { state: "skipped", reason: "campaign_group_run_bound_exceeded" };
    }
    mutationBudget.attempted += 1;
    try {
      const result = (await convex.mutation(crossPostCoalescingMutation, {
        operationId,
        primary: versions[0],
        duplicates: versions.slice(1),
        targetVenueId: context.targetVenue._id,
        expectedTargetVenueUpdatedAt: context.targetVenue.updatedAt,
        sharedEvidenceAnchors: anchors,
        automaticCampaignIdentity,
        moderationNote:
          `Automatic completed-run campaign coalescing: exact author, canonical venue, date, confirmed start time, and bounded occurrence-specific campaign proof with hashtags ${anchors.join(", ")}.`,
        serviceSecret,
      })) as { foldedVariantIds: string[] };
      return { state: "coalesced", foldedVariantCount: result.foldedVariantIds.length };
    } catch (error) {
      lastMutationError = error;
    }
  }
  if (isSafetyRefusal(lastMutationError)) {
    return {
      state: "skipped",
      reason:
        lastMutationError instanceof Error
          ? lastMutationError.message
          : "mutation safety refusal",
    };
  }
  throw lastMutationError instanceof Error
    ? lastMutationError
    : new Error("Unknown cross-post campaign mutation failure.");
}

export async function runApprovedCrossPostCampaignAutoCoalescing(
  convex: ConvexHttpClient,
  options: { serviceSecret: string },
): Promise<ApprovedCrossPostCampaignAutoCoalesceSummary> {
  const summary: ApprovedCrossPostCampaignAutoCoalesceSummary = {
    scannedEventCount: 0,
    candidateGroupCount: 0,
    coalescedGroupCount: 0,
    foldedVariantCount: 0,
    alreadyCoalescedGroupCount: 0,
    skippedGroupCount: 0,
    skipped: [],
    failedCount: 0,
    failures: [],
  };
  try {
    const [loaded, venues] = await Promise.all([
      loadApprovedEvents(convex, options.serviceSecret),
      loadPublicCanonicalVenues(convex),
    ]);
    summary.scannedEventCount = loaded.events.length;
    if (!loaded.complete) {
      summary.error = `Approved-event scan exceeded the safe ${MAX_APPROVED_SCAN}-row bound.`;
      return summary;
    }
    const grouped = buildApprovedCrossPostCampaignCohorts(loaded.events, { venues });
    summary.candidateGroupCount = grouped.cohorts.length;
    summary.skipped.push(...grouped.skipped);
    const mutationBudget = { attempted: 0 };
    const sourceHistoryCache = new Map<
      string,
      Promise<{ posts: CrossPostCampaignHistoryPost[]; complete: boolean }>
    >();
    for (const cohort of grouped.cohorts) {
      if (!scannedCohortHasAutomaticCampaignProof(cohort)) {
        summary.skipped.push({
          eventIds: cohort.events.map((event) => event._id),
          reason: "shared_campaign_proof_insufficient",
        });
        continue;
      }
      if (mutationBudget.attempted >= MAX_CAMPAIGN_GROUPS_PER_RUN) {
        summary.skipped.push({
          eventIds: cohort.events.map((event) => event._id),
          reason: "campaign_group_run_bound_exceeded",
        });
        continue;
      }
      try {
        const result = await runCohort(
          convex,
          cohort,
          options.serviceSecret,
          mutationBudget,
          sourceHistoryCache,
        );
        if (result.state === "skipped") {
          summary.skipped.push({
            eventIds: cohort.events.map((event) => event._id),
            reason: result.reason.slice(0, 512),
          });
          continue;
        }
        if (result.state === "already_coalesced") {
          summary.alreadyCoalescedGroupCount += 1;
        } else {
          summary.coalescedGroupCount += 1;
        }
        summary.foldedVariantCount += result.foldedVariantCount;
      } catch (error) {
        summary.failures.push({
          eventIds: cohort.events.map((event) => event._id),
          error: error instanceof Error ? error.message.slice(0, 512) : "Unknown failure.",
        });
      }
    }
    summary.skippedGroupCount = summary.skipped.length;
    summary.failedCount = summary.failures.length;
    return summary;
  } catch (error) {
    summary.error = error instanceof Error ? error.message : "Unknown campaign sweep failure.";
    return summary;
  }
}

export function assertApprovedCrossPostCampaignAutoCoalescingCompleted(
  summary: ApprovedCrossPostCampaignAutoCoalesceSummary,
): void {
  if (summary.error) {
    throw new Error(`Cross-post campaign cleanup failed: ${summary.error}`);
  }
  if (summary.failedCount > 0) {
    throw new Error(
      `Cross-post campaign cleanup failed for ${summary.failedCount} cohort(s).`,
    );
  }
}
