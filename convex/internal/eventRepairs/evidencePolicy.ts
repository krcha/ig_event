import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { buildUnnamedScheduleFallbackTitle } from "../../../lib/events/unnamed-schedule-fallback";
import {
  normalizeHandle,
  toSearchableText,
} from "../../../lib/pipeline/venue-normalization";
import { requireAdminOrServiceSecret } from "../../authz";
import {
  assertExistingSourceOccurrenceReceiptWithinBounds,
  eventRepresentsExpectedOccurrence,
} from "../sourceOccurrenceReceipts";
import { markSourceOccurrenceTopologyMutation } from "../sourceOccurrenceTopologyEpoch";
import { savedEventRepository } from "../../repositories/savedEvents";
import { sourceOccurrenceProvenanceRepository } from "../../repositories/sourceOccurrenceProvenance";
import type { EventEvidencePolicyReprocessItem } from "../../eventDomain/contracts";
import { applyEventUpdate } from "../../eventDomain/eventUpdates";
import { refreshCanonicalEventDerivedStates } from "../../eventDomain/persistence";
import { requireCanonicalInstagramPostUrl } from "../../eventDomain/sourceUrlPolicy";
import {
  normalizedString,
  stringArraysEqual,
} from "../../eventDomain/valueNormalization";

const MAX_EVENT_EVIDENCE_POLICY_REPROCESS_BATCH_SIZE = 16;

function assertEventEvidencePolicyReprocessPatch(
  item: EventEvidencePolicyReprocessItem,
  nextStatus: "approved" | "pending",
): void {
  if (
    !Number.isSafeInteger(item.expectedUpdatedAt) ||
    item.patch.status !== nextStatus ||
    typeof item.patch.normalizedFieldsJson !== "string" ||
    item.patch.normalizedFieldsJson.length === 0
  ) {
    throw new Error(
      "Event-evidence policy replay requires an exact status and normalized payload.",
    );
  }
}

export function assertEventEvidencePolicyTitleTransitionForTesting(
  event: Doc<"events">,
  item: EventEvidencePolicyReprocessItem,
): void {
  const currentFields = parseEventEvidencePolicyNormalizedFields(
    event.normalizedFieldsJson ?? "",
  );
  const nextFields = parseEventEvidencePolicyNormalizedFields(
    item.patch.normalizedFieldsJson,
  );
  const currentUsesFallback =
    currentFields.titleUsedFallback === true &&
    currentFields.titleSource === "unnamed_schedule_fallback";
  const nextUsesFallback =
    nextFields.titleUsedFallback === true &&
    nextFields.titleSource === "unnamed_schedule_fallback";
  const nextTitle = item.patch.title ?? event.title;
  if (!currentUsesFallback && !nextUsesFallback) {
    if (nextTitle === event.title) return;
    throw new Error(
      `Event-evidence policy replay can change only deterministic unnamed fallback titles: ${item.id}.`,
    );
  }
  const currentVersion = currentFields.fallbackIdentityPolicyVersion;
  const nextVersion = nextFields.fallbackIdentityPolicyVersion;
  const currentVersionValid =
    currentVersion === undefined || currentVersion === 1;
  const nextVersionValid = nextVersion === undefined || nextVersion === 1;
  const migratesLegacyVersion =
    (currentVersion === undefined && nextVersion === 1) ||
    (currentVersion === 1 && nextVersion === undefined);
  const versionsSupported =
    (currentVersion === 1 && nextVersion === 1) || migratesLegacyVersion;
  const currentTitleValid =
    currentVersion === 1
      ? fallbackTitleMatchesVenueCandidates(event.title, event, [event.venue])
      : fallbackTitleMatchesVenueCandidates(
          event.title,
          event,
          legacyFallbackVenueCandidates(event, currentFields, nextFields),
        );
  const nextPublicVenue = item.patch.venue ?? event.venue;
  const nextTitleValid =
    nextVersion === 1
      ? fallbackTitleMatchesVenueCandidates(nextTitle, event, [nextPublicVenue])
      : fallbackTitleMatchesVenueCandidates(
          nextTitle,
          event,
          legacyFallbackVenueCandidates(event, nextFields, currentFields),
        );
  if (
    !currentUsesFallback ||
    !nextUsesFallback ||
    !currentVersionValid ||
    !nextVersionValid ||
    !versionsSupported ||
    !currentTitleValid ||
    !nextTitleValid
  ) {
    throw new Error(
      `Event-evidence policy replay can change only deterministic unnamed fallback titles: ${item.id}.`,
    );
  }
}

function compactFallbackIdentity(value: unknown): string {
  return toSearchableText(typeof value === "string" ? value : "").replace(
    /[^\p{L}\p{N}]+/gu,
    "",
  );
}

function verifiedFallbackSourceAccountName(
  fields: Record<string, unknown>,
  pairedFields: Record<string, unknown>,
): string {
  const handle = normalizeHandle(
    typeof fields.sourceGroundingInstagramHandle === "string"
      ? fields.sourceGroundingInstagramHandle
      : "",
  );
  const pairedHandle = normalizeHandle(
    typeof pairedFields.sourceGroundingInstagramHandle === "string"
      ? pairedFields.sourceGroundingInstagramHandle
      : "",
  );
  const candidates = [fields.sourceAccountName, pairedFields.sourceAccountName];
  if (!handle || !pairedHandle || handle !== pairedHandle) return "";
  return (
    candidates.find(
      (candidate): candidate is string =>
        typeof candidate === "string" &&
        compactFallbackIdentity(candidate) === compactFallbackIdentity(handle),
    ) ?? ""
  );
}

function boundRawFallbackVenues(
  event: Doc<"events">,
  fields: Record<string, unknown>,
  pairedFields: Record<string, unknown>,
): string[] {
  let rawExtraction: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(event.rawExtractionJson ?? "null") as unknown;
    rawExtraction =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
  } catch {
    rawExtraction = null;
  }
  const scheduleEntries = Array.isArray(rawExtraction?.schedule_entries)
    ? rawExtraction.schedule_entries.filter(
        (entry): entry is Record<string, unknown> =>
          Boolean(entry && typeof entry === "object" && !Array.isArray(entry)),
      )
    : [];
  const rowSourceText = normalizedString(fields.rowSourceText);
  const pairedRowSourceText = normalizedString(pairedFields.rowSourceText);
  const sharedRowSourceText =
    rowSourceText && rowSourceText === pairedRowSourceText ? rowSourceText : "";
  const matchingEntries = sharedRowSourceText
    ? scheduleEntries.filter(
        (entry) => normalizedString(entry.source_text) === sharedRowSourceText,
      )
    : [];
  const boundEntries =
    matchingEntries.length > 0
      ? matchingEntries
      : scheduleEntries.length === 1
        ? scheduleEntries
        : [];
  return boundEntries
    .map((entry) => normalizedString(entry.venue))
    .filter(Boolean);
}

function legacyFallbackVenueCandidates(
  event: Doc<"events">,
  fields: Record<string, unknown>,
  pairedFields: Record<string, unknown>,
): string[] {
  return [
    "",
    event.venue,
    ...boundRawFallbackVenues(event, fields, pairedFields),
    verifiedFallbackSourceAccountName(fields, pairedFields),
  ].filter(
    (value, index, values) =>
      values.findIndex(
        (candidate) => normalizedString(candidate) === normalizedString(value),
      ) === index,
  );
}

function fallbackTitleMatchesVenueCandidates(
  title: string,
  event: Pick<Doc<"events">, "date" | "eventType">,
  venues: string[],
): boolean {
  return venues.some(
    (venue) =>
      normalizedString(title) ===
      normalizedString(
        buildUnnamedScheduleFallbackTitle({
          eventType: event.eventType,
          venue,
          isoDate: event.date,
        }),
      ),
  );
}

function parseEventEvidencePolicyNormalizedFields(
  value: string,
): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to the fail-closed error below.
  }
  throw new Error(
    "Event-evidence policy replay normalized payload is invalid.",
  );
}

const EVENT_EVIDENCE_REPLAY_MONTHS = new Map<string, number>([
  ["januar", 1],
  ["januara", 1],
  ["january", 1],
  ["februar", 2],
  ["februara", 2],
  ["february", 2],
  ["mart", 3],
  ["marta", 3],
  ["march", 3],
  ["april", 4],
  ["aprila", 4],
  ["maj", 5],
  ["maja", 5],
  ["may", 5],
  ["jun", 6],
  ["juna", 6],
  ["june", 6],
  ["jul", 7],
  ["jula", 7],
  ["july", 7],
  ["avgust", 8],
  ["avgusta", 8],
  ["august", 8],
  ["septembar", 9],
  ["septembra", 9],
  ["september", 9],
  ["oktobar", 10],
  ["oktobra", 10],
  ["october", 10],
  ["novembar", 11],
  ["novembra", 11],
  ["november", 11],
  ["decembar", 12],
  ["decembra", 12],
  ["december", 12],
]);

function collectEventEvidenceReplayRangeDates(
  evidenceText: string,
  referenceDate: string,
): Set<string> | null {
  const match = evidenceText
    .toLocaleLowerCase("sr-Latn")
    .match(
      /(?:^|[^\p{L}\p{N}_])(?:od\s+)?(\d{1,2})\.?\s*([\p{L}]+)(?:\s*,?\s*(\d{2,4}))?\s*(?:do|to|through|thru|[-–—])\s*(\d{1,2})\.?\s*([\p{L}]+)(?:\s*,?\s*(\d{2,4}))?/iu,
    );
  const referenceYear = Number.parseInt(referenceDate.slice(0, 4), 10);
  const startMonth = EVENT_EVIDENCE_REPLAY_MONTHS.get(match?.[2] ?? "");
  const endMonth = EVENT_EVIDENCE_REPLAY_MONTHS.get(match?.[5] ?? "");
  if (
    !match ||
    !startMonth ||
    !endMonth ||
    !Number.isSafeInteger(referenceYear)
  )
    return null;
  const parseYear = (value: string | undefined): number | null => {
    if (!value) return null;
    const parsed = Number.parseInt(value, 10);
    return value.length === 2 ? 2000 + parsed : parsed;
  };
  let startYear = parseYear(match[3]) ?? parseYear(match[6]) ?? referenceYear;
  const endYear = parseYear(match[6]) ?? parseYear(match[3]) ?? referenceYear;
  if (!match[3] && startMonth > endMonth) startYear = endYear - 1;
  const start = new Date(
    Date.UTC(startYear, startMonth - 1, Number.parseInt(match[1], 10)),
  );
  const end = new Date(
    Date.UTC(endYear, endMonth - 1, Number.parseInt(match[4], 10)),
  );
  if (
    start.getUTCFullYear() !== startYear ||
    start.getUTCMonth() !== startMonth - 1 ||
    start.getUTCDate() !== Number.parseInt(match[1], 10) ||
    end.getUTCFullYear() !== endYear ||
    end.getUTCMonth() !== endMonth - 1 ||
    end.getUTCDate() !== Number.parseInt(match[4], 10) ||
    end.getTime() < start.getTime()
  ) {
    return null;
  }
  const dayCount =
    Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1;
  if (dayCount < 2 || dayCount > 31) return null;
  return new Set(
    Array.from({ length: dayCount }, (_, index) =>
      new Date(start.getTime() + index * 86_400_000).toISOString().slice(0, 10),
    ),
  );
}

export function assertEventEvidencePolicyDateEvidenceTransitionForTesting(
  event: Doc<"events">,
  item: EventEvidencePolicyReprocessItem,
): void {
  const unchanged =
    item.patch.dateEvidenceText === event.dateEvidenceText &&
    item.patch.dateEvidenceSource === event.dateEvidenceSource &&
    item.patch.dateEvidenceIsRelative === event.dateEvidenceIsRelative &&
    item.patch.dateEvidenceResolvedDate === event.dateEvidenceResolvedDate;
  if (unchanged) return;
  if (
    item.patch.dateEvidenceText !== event.dateEvidenceText ||
    item.patch.dateEvidenceSource !== event.dateEvidenceSource ||
    item.patch.dateEvidenceIsRelative !== event.dateEvidenceIsRelative ||
    typeof event.dateEvidenceText !== "string" ||
    typeof event.dateEvidenceResolvedDate !== "string" ||
    typeof item.patch.dateEvidenceResolvedDate !== "string"
  ) {
    throw new Error(
      `Event-evidence policy replay cannot change date evidence: ${item.id}.`,
    );
  }
  const rangeDates = collectEventEvidenceReplayRangeDates(
    event.dateEvidenceText,
    event.date,
  );
  let rawExtraction: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(event.rawExtractionJson ?? "null") as unknown;
    rawExtraction =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
  } catch {
    rawExtraction = null;
  }
  const rawDateEvidence = rawExtraction?.date_evidence;
  const rawScheduleEntries = rawExtraction?.schedule_entries;
  const rawEvidenceCandidates = [
    rawDateEvidence,
    ...(Array.isArray(rawScheduleEntries)
      ? rawScheduleEntries.map((entry) =>
          entry && typeof entry === "object" && !Array.isArray(entry)
            ? (entry as Record<string, unknown>).date_evidence
            : null,
        )
      : []),
  ].filter((value): value is Record<string, unknown> =>
    Boolean(value && typeof value === "object" && !Array.isArray(value)),
  );
  const rawEvidenceMatches = rawEvidenceCandidates.some(
    (evidence) =>
      normalizedString(evidence.exact_text) ===
        normalizedString(event.dateEvidenceText) &&
      evidence.source === event.dateEvidenceSource &&
      typeof evidence.resolved_date === "string" &&
      rangeDates?.has(evidence.resolved_date),
  );
  if (
    !rangeDates ||
    !rawEvidenceMatches ||
    !rangeDates.has(event.date) ||
    !rangeDates.has(event.dateEvidenceResolvedDate) ||
    !rangeDates.has(item.patch.dateEvidenceResolvedDate) ||
    ![
      event.dateEvidenceResolvedDate,
      item.patch.dateEvidenceResolvedDate,
    ].includes(event.date)
  ) {
    throw new Error(
      `Event-evidence policy replay date-range correction failed: ${item.id}.`,
    );
  }
}

const assertEventEvidencePolicyDateEvidenceTransition =
  assertEventEvidencePolicyDateEvidenceTransitionForTesting;

function assertEventEvidencePolicyNormalizedBinding(options: {
  normalizedFieldsJson: string;
  occurrenceKey: string;
  sourceFingerprint: string;
  publicFields: {
    artists: string[];
    date: string;
    dateEvidenceIsRelative?: boolean;
    dateEvidenceResolvedDate?: string;
    dateEvidenceSource?: string;
    dateEvidenceText?: string;
    sourceConflictFields?: string[];
    time?: string;
    title: string;
    venue: string;
  };
}): void {
  const fields = parseEventEvidencePolicyNormalizedFields(
    options.normalizedFieldsJson,
  );
  const event = options.publicFields;
  if (
    fields.sourceOccurrenceKey !== options.occurrenceKey ||
    fields.sourceOccurrenceSourceFingerprint !== options.sourceFingerprint ||
    normalizedString(fields.title) !== normalizedString(event.title) ||
    normalizedString(fields.normalizedDate) !== normalizedString(event.date) ||
    normalizedString(fields.time) !== normalizedString(event.time) ||
    normalizedString(fields.normalizedVenue) !==
      normalizedString(event.venue) ||
    !stringArraysEqual(fields.artists, event.artists) ||
    !stringArraysEqual(
      fields.sourceConflictFields,
      event.sourceConflictFields ?? [],
    ) ||
    normalizedString(fields.dateEvidenceText) !==
      normalizedString(event.dateEvidenceText) ||
    fields.dateEvidenceSource !== event.dateEvidenceSource ||
    fields.dateEvidenceIsRelative !== event.dateEvidenceIsRelative ||
    normalizedString(fields.dateEvidenceResolvedDate) !==
      normalizedString(event.dateEvidenceResolvedDate)
  ) {
    throw new Error(
      "Event-evidence policy replay normalized/public binding failed.",
    );
  }
}

async function applyEventEvidencePolicyTransition(
  ctx: MutationCtx,
  args: {
    sourceIdentity: string;
    expectedReceiptId: Id<"instagramSourceOccurrenceReceipts">;
    expectedReceiptUpdatedAt: number;
    expectedSourceFingerprint: string;
    items: EventEvidencePolicyReprocessItem[];
  },
  authorization: { actor: string; kind: "service" },
  transition: "apply" | "rollback",
): Promise<{
  updatedCount: number;
  eventIds: Id<"events">[];
  eventUpdatedAts: Array<{ id: Id<"events">; updatedAt: number }>;
  receiptUpdatedAt: number;
}> {
  const currentStatus = transition === "apply" ? "pending" : "approved";
  const nextStatus = transition === "apply" ? "approved" : "pending";
  if (
    !args.sourceIdentity ||
    !args.expectedSourceFingerprint ||
    !Number.isSafeInteger(args.expectedReceiptUpdatedAt) ||
    args.items.length === 0 ||
    args.items.length > MAX_EVENT_EVIDENCE_POLICY_REPROCESS_BATCH_SIZE
  ) {
    throw new Error("Event-evidence policy replay batch is invalid.");
  }

  const uniqueEventIds = new Set(args.items.map((item) => item.id));
  if (uniqueEventIds.size !== args.items.length) {
    throw new Error("Event-evidence policy replay requires unique event IDs.");
  }
  for (const item of args.items) {
    assertEventEvidencePolicyReprocessPatch(item, nextStatus);
  }

  const receiptRows = await ctx.db
    .query("instagramSourceOccurrenceReceipts")
    .withIndex("by_sourceIdentity", (q) =>
      q.eq("sourceIdentity", args.sourceIdentity),
    )
    .take(2);
  const receipt = receiptRows.length === 1 ? receiptRows[0] : null;
  if (
    !receipt ||
    receipt._id !== args.expectedReceiptId ||
    receipt.updatedAt !== args.expectedReceiptUpdatedAt ||
    receipt.sourceFingerprint !== args.expectedSourceFingerprint ||
    !Array.isArray(receipt.expectedOccurrences)
  ) {
    throw new Error(
      "Event-evidence policy replay receipt precondition failed.",
    );
  }
  assertExistingSourceOccurrenceReceiptWithinBounds(receipt);
  const expectedReceiptKeys = receipt.expectedOccurrences.map(
    (occurrence) => occurrence.key,
  );
  const satisfiedReceiptKeys = receipt.satisfiedOccurrences.map(
    (occurrence) => occurrence.key,
  );
  if (
    new Set(expectedReceiptKeys).size !== expectedReceiptKeys.length ||
    new Set(satisfiedReceiptKeys).size !== satisfiedReceiptKeys.length ||
    expectedReceiptKeys.length !== satisfiedReceiptKeys.length ||
    expectedReceiptKeys.some((key) => !satisfiedReceiptKeys.includes(key))
  ) {
    throw new Error(
      "Event-evidence policy replay requires a complete unique occurrence receipt.",
    );
  }

  const prepared: Array<{
    event: Doc<"events">;
    item: EventEvidencePolicyReprocessItem;
    sourceLink: Doc<"instagramEventSources">;
    sourceOccurrenceKey: string;
  }> = [];
  const replayKeys = new Set<string>();
  for (const item of args.items) {
    const event = await ctx.db.get(item.id);
    if (
      !event ||
      event.status !== currentStatus ||
      event.updatedAt !== item.expectedUpdatedAt ||
      event.normalizedFieldsJson !== item.expectedNormalizedFieldsJson
    ) {
      throw new Error(
        `Event-evidence policy replay event precondition failed: ${item.id}.`,
      );
    }
    if (transition === "rollback") {
      const savedReferences = await savedEventRepository.loadEventReferences(
        ctx,
        event._id,
        { limit: 1 },
      );
      if (
        savedReferences.canonical.length > 0 ||
        savedReferences.legacy.length > 0
      ) {
        throw new Error(
          `Event-evidence policy rollback refused for a saved event: ${item.id}.`,
        );
      }
    }
    const sourceLinks = await ctx.db
      .query("instagramEventSources")
      .withIndex("by_event", (q) => q.eq("eventId", event._id))
      .take(2);
    const sourceLink = sourceLinks.length === 1 ? sourceLinks[0] : null;
    const expectedOccurrence = receipt.expectedOccurrences.find(
      (occurrence) => occurrence.key === sourceLink?.sourceOccurrenceKey,
    );
    const satisfiedOccurrence = receipt.satisfiedOccurrences.find(
      (occurrence) => occurrence.key === sourceLink?.sourceOccurrenceKey,
    );
    if (transition === "apply") {
      const eventPostUrl = requireCanonicalInstagramPostUrl(
        event.instagramPostUrl,
        `Event-evidence policy approval ${event._id}`,
      );
      if (
        sourceLink &&
        requireCanonicalInstagramPostUrl(
          sourceLink.instagramPostUrl,
          `Event-evidence policy source link ${event._id}`,
        ) !== eventPostUrl
      ) {
        throw new Error(
          `Event-evidence policy replay source URL mismatch: ${item.id}.`,
        );
      }
    }
    if (
      !sourceLink ||
      sourceLink.sourceIdentity !== receipt.sourceIdentity ||
      sourceLink.sourceFingerprint !== receipt.sourceFingerprint ||
      sourceLink.sourceOccurrenceKey !== event.sourceOccurrenceKey ||
      !expectedOccurrence ||
      satisfiedOccurrence?.eventId !== event._id ||
      replayKeys.has(sourceLink.sourceOccurrenceKey) ||
      !eventRepresentsExpectedOccurrence(event, expectedOccurrence, {
        allowUnverifiedPending: true,
      })
    ) {
      throw new Error(
        `Event-evidence policy replay occurrence precondition failed: ${item.id}.`,
      );
    }
    assertEventEvidencePolicyDateEvidenceTransition(event, item);
    assertEventEvidencePolicyTitleTransitionForTesting(event, item);
    assertEventEvidencePolicyNormalizedBinding({
      normalizedFieldsJson: event.normalizedFieldsJson ?? "",
      occurrenceKey: sourceLink.sourceOccurrenceKey,
      sourceFingerprint: receipt.sourceFingerprint,
      publicFields: event,
    });
    assertEventEvidencePolicyNormalizedBinding({
      normalizedFieldsJson: item.patch.normalizedFieldsJson,
      occurrenceKey: sourceLink.sourceOccurrenceKey,
      sourceFingerprint: receipt.sourceFingerprint,
      publicFields: {
        ...event,
        artists: item.patch.artists ?? event.artists,
        dateEvidenceIsRelative: item.patch.dateEvidenceIsRelative,
        dateEvidenceResolvedDate: item.patch.dateEvidenceResolvedDate,
        dateEvidenceSource: item.patch.dateEvidenceSource,
        dateEvidenceText: item.patch.dateEvidenceText,
        sourceConflictFields: item.patch.sourceConflictFields,
        title: item.patch.title ?? event.title,
        venue: item.patch.venue ?? event.venue,
      },
    });
    replayKeys.add(sourceLink.sourceOccurrenceKey);
    prepared.push({
      event,
      item,
      sourceLink,
      sourceOccurrenceKey: sourceLink.sourceOccurrenceKey,
    });
  }

  const eventUpdatedAts: Array<{ id: Id<"events">; updatedAt: number }> = [];
  for (const { event, item } of prepared) {
    const result = await applyEventUpdate(
      ctx,
      {
        id: event._id,
        patch: item.patch,
        expectedStatus: currentStatus,
        expectedUpdatedAt: item.expectedUpdatedAt,
      },
      authorization,
      { occurrenceRebindFollows: true },
    );
    eventUpdatedAts.push({ id: event._id, updatedAt: result.updatedAt });
  }

  const nextExpectedOccurrences = [...receipt.expectedOccurrences];
  for (const { event, sourceOccurrenceKey } of prepared) {
    const updatedEvent = await ctx.db.get(event._id);
    const expectedIndex = nextExpectedOccurrences.findIndex(
      (occurrence) => occurrence.key === sourceOccurrenceKey,
    );
    if (!updatedEvent || expectedIndex < 0) {
      throw new Error(
        "Event-evidence policy replay lost an occurrence representative.",
      );
    }
    const nextExpectedOccurrence = {
      key: sourceOccurrenceKey,
      date: updatedEvent.date,
      ...(updatedEvent.time ? { time: updatedEvent.time } : {}),
      venue: updatedEvent.venue,
      title: updatedEvent.title,
      artists: updatedEvent.artists,
    };
    if (
      !eventRepresentsExpectedOccurrence(updatedEvent, nextExpectedOccurrence)
    ) {
      throw new Error(
        "Event-evidence policy replay produced an invalid occurrence binding.",
      );
    }
    nextExpectedOccurrences[expectedIndex] = nextExpectedOccurrence;
  }

  for (const satisfied of receipt.satisfiedOccurrences) {
    const representative = await ctx.db.get(satisfied.eventId);
    const expected = nextExpectedOccurrences.find(
      (occurrence) => occurrence.key === satisfied.key,
    );
    if (!eventRepresentsExpectedOccurrence(representative, expected)) {
      throw new Error(
        "Event-evidence policy replay would invalidate a receipt sibling.",
      );
    }
  }

  const receiptUpdatedAt = Math.max(Date.now(), receipt.updatedAt + 1);
  await ctx.db.patch(receipt._id, {
    expectedOccurrences: nextExpectedOccurrences,
    updatedAt: receiptUpdatedAt,
  });
  for (const { event, sourceLink, sourceOccurrenceKey } of prepared) {
    const representative = await ctx.db.get(event._id);
    const expected = nextExpectedOccurrences.find(
      (occurrence) => occurrence.key === sourceOccurrenceKey,
    );
    if (!representative || !expected) {
      throw new Error(
        "Event-evidence policy replay lost its first-class occurrence binding.",
      );
    }
    await sourceOccurrenceProvenanceRepository.updateSatisfiedOccurrenceFromExpected(
      ctx,
      {
        expected,
        representative,
        sourceFingerprint: receipt.sourceFingerprint,
        sourceLink,
        topologyEpochVerified: true,
      },
    );
  }
  await markSourceOccurrenceTopologyMutation(ctx, { verified: true });
  await refreshCanonicalEventDerivedStates(
    ctx,
    receipt.satisfiedOccurrences.map((occurrence) => occurrence.eventId),
  );
  return {
    updatedCount: prepared.length,
    eventIds: prepared.map(({ event }) => event._id),
    eventUpdatedAts,
    receiptUpdatedAt,
  };
}

export async function reprocessPendingEventEvidencePolicyBatchHandler(
  ctx: MutationCtx,
  args: {
    sourceIdentity: string;
    expectedReceiptId: Id<"instagramSourceOccurrenceReceipts">;
    expectedReceiptUpdatedAt: number;
    expectedSourceFingerprint: string;
    items: EventEvidencePolicyReprocessItem[];
    serviceSecret: string;
  },
) {
  const authorization = await requireAdminOrServiceSecret(
    ctx,
    args.serviceSecret,
  );
  if (authorization.kind !== "service") {
    throw new Error(
      "Event-evidence policy replay requires service authentication.",
    );
  }
  return applyEventEvidencePolicyTransition(
    ctx,
    args,
    { actor: authorization.actor, kind: "service" },
    "apply",
  );
}

export async function rollbackEventEvidencePolicyBatchHandler(
  ctx: MutationCtx,
  args: {
    sourceIdentity: string;
    expectedReceiptId: Id<"instagramSourceOccurrenceReceipts">;
    expectedReceiptUpdatedAt: number;
    expectedSourceFingerprint: string;
    items: EventEvidencePolicyReprocessItem[];
    serviceSecret: string;
  },
) {
  const authorization = await requireAdminOrServiceSecret(
    ctx,
    args.serviceSecret,
  );
  if (authorization.kind !== "service") {
    throw new Error(
      "Event-evidence policy rollback requires service authentication.",
    );
  }
  return applyEventEvidencePolicyTransition(
    ctx,
    args,
    { actor: authorization.actor, kind: "service" },
    "rollback",
  );
}
