import { createHash } from "node:crypto";
import { normalizeEventTime } from "@/lib/events/event-time";
import {
  getStructuredFactsOccurrenceTime,
  serializeStructuredFacts,
} from "@/lib/domain/occurrences/facts";
import {
  serializeCanonicalEventPayload,
  type CanonicalEventPayload,
} from "@/lib/domain/occurrences/canonical-event-payload";
import type { StructuredFacts } from "@/lib/domain/occurrences/types";
import { buildInstagramSourceOccurrenceFingerprint } from "@/lib/domain/occurrences/source-fingerprint";
import { buildSourceDocumentIdentity } from "@/lib/domain/source-documents";
import { canonicalizeSourceUrl } from "@/lib/domain/source-url";
import { toSearchableText } from "@/lib/pipeline/venue-normalization";
import type { InstagramScrapedPost } from "@/lib/scraper/instagram-scraper";

type OccurrencePreparedEvent = {
  date: string;
  time?: string;
  venue: string;
  title: string;
  artists: string[];
  status: string;
  sourceOccurrenceKey?: string;
  normalizedFieldsJson?: string;
};

type OccurrencePrepareResult =
  | {
      kind: "ok";
      event: OccurrencePreparedEvent;
      normalizedFields: Record<string, unknown>;
    }
  | {
      kind: "skip";
      reason: string;
      normalizedFields: Record<string, unknown>;
    };

export type SourceOccurrenceFactResult =
  | {
      kind: "event";
      facts: StructuredFacts;
      normalizedFields: Record<string, unknown>;
      canonicalEvent?: CanonicalEventPayload;
    }
  | {
      kind: "skip";
      reason: string;
      normalizedFields: Record<string, unknown>;
    };

type ExistingSourceMatchLike = {
  existingEvent: {
    date: string;
    time?: string;
    normalizedFieldsJson?: string;
    sourceOccurrenceKey?: string;
  };
};

export type SourceOccurrencePlan = {
  sourceIdentity: string;
  sourceFingerprint: string;
  expectedKeys: string[];
  expectedOccurrences: Array<{
    key: string;
    date: string;
    time?: string;
    venue: string;
    title: string;
    artists: string[];
    factsJson?: string;
    canonicalEventJson?: string;
  }>;
  deferredChildCount: number;
  deferredChildKeys: string[];
  observedChildKeys: string[];
  previousSourceFingerprint?: string | null;
  confirmedPastKeys?: string[];
};

export type SourceOccurrenceReceipt = {
  sourceIdentity: string;
  sourceFingerprint: string;
  expectedKeys: string[];
  satisfiedKeys: string[];
  satisfiedOccurrences: Array<{ key: string; eventId: string }>;
  deferredChildCount: number;
  deferredChildKeys: string[];
};

function normalizeString(value: string | null | undefined): string {
  return (value ?? "").trim();
}

function parseJsonRecord(value: string | undefined): Record<string, unknown> | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readJsonBoolean(
  record: Record<string, unknown> | null,
  key: string,
): boolean | null {
  const value = record?.[key];
  return typeof value === "boolean" ? value : null;
}

function readJsonString(
  record: Record<string, unknown> | null,
  key: string,
): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readJsonStringArray(
  record: Record<string, unknown> | null,
  key: string,
): string[] {
  const value = record?.[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
  );
}

function readJsonNumber(
  record: Record<string, unknown> | null,
  key: string,
): number | null {
  const value = record?.[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function extractComparableTimeParts(value: string | undefined): string[] {
  const matches = normalizeString(value).match(/\d{1,2}(?::\d{2})?/g) ?? [];
  return matches.map((match) => {
    const [hours, minutes = "00"] = match.split(":");
    return `${hours.padStart(2, "0")}:${minutes.padStart(2, "0")}`;
  });
}

function isMultiEventNormalizedFields(
  normalizedFields: Record<string, unknown> | null,
): boolean {
  return (
    readJsonBoolean(normalizedFields, "multiEventSplitDetected") === true ||
    (readJsonNumber(normalizedFields, "multiEventSplitCount") ?? 0) > 1
  );
}

function isDateRangeExpandedNormalizedFields(
  normalizedFields: Record<string, unknown> | null,
): boolean {
  return (
    readJsonBoolean(normalizedFields, "dateRangeExpanded") === true ||
    (readJsonNumber(normalizedFields, "dateRangeExpandedCount") ?? 0) > 1
  );
}

function isMultiOccurrenceNormalizedFields(
  normalizedFields: Record<string, unknown> | null,
): boolean {
  return (
    isMultiEventNormalizedFields(normalizedFields) ||
    isDateRangeExpandedNormalizedFields(normalizedFields) ||
    (readJsonNumber(normalizedFields, "expandedDateTotal") ?? 0) > 1
  );
}

function getSourceOccurrenceProvenanceKey(
  normalizedFields: Record<string, unknown> | null,
): string | null {
  const rowSourceText =
    readJsonString(normalizedFields, "rowSourceText") ??
    readJsonString(normalizedFields, "splitSourceLine");
  return toSearchableText(rowSourceText ?? "") || null;
}

export function buildSourceOccurrenceFingerprint(
  post: InstagramScrapedPost,
): string {
  return buildInstagramSourceOccurrenceFingerprint(post);
}

export function buildSourceOccurrenceIdentity(post: InstagramScrapedPost): string {
  const canonicalSource = canonicalizeSourceUrl(
    "instagram",
    post.instagramPostUrl,
  );
  const externalId =
    (canonicalSource.ok ? canonicalSource.value.externalId : "") ||
    normalizeString(post.postId) ||
    normalizeString(post.instagramPostUrl).toLowerCase();
  return buildSourceDocumentIdentity("instagram", externalId);
}

export function hasIncompleteSourceOccurrenceSetForTesting(
  matches: ExistingSourceMatchLike[],
  post: InstagramScrapedPost,
): boolean {
  let expectedOccurrenceCount = 0;
  let expectedKeySignature: string | null = null;
  let expectedKeySet: Set<string> | null = null;
  let allTrackedRowsHaveExactV2Metadata = true;
  const persistedOccurrenceKeys = new Set<string>();
  const currentSourceFingerprint = buildSourceOccurrenceFingerprint(post);

  for (const match of matches) {
    const normalizedFields = parseJsonRecord(match.existingEvent.normalizedFieldsJson);
    const persistedSourceFingerprint = readJsonString(
      normalizedFields,
      "sourceOccurrenceSourceFingerprint",
    );
    if (!persistedSourceFingerprint || persistedSourceFingerprint !== currentSourceFingerprint) {
      return true;
    }
    if (!isMultiOccurrenceNormalizedFields(normalizedFields)) {
      continue;
    }
    if ((readJsonNumber(normalizedFields, "sourceOccurrenceDeferredChildCount") ?? 0) > 0) {
      return true;
    }

    const fallbackExpectedOccurrenceCount = isDateRangeExpandedNormalizedFields(
      normalizedFields,
    )
      ? (readJsonNumber(normalizedFields, "dateRangeExpandedCount") ??
        readJsonNumber(normalizedFields, "expandedDateTotal") ??
        2)
      : (readJsonNumber(normalizedFields, "multiEventSplitCount") ??
        readJsonNumber(normalizedFields, "expandedDateTotal") ??
        2);
    const rowExpectedCount =
      readJsonNumber(normalizedFields, "sourceOccurrenceExpectedCount") ??
      fallbackExpectedOccurrenceCount;
    expectedOccurrenceCount = Math.max(expectedOccurrenceCount, rowExpectedCount);
    const persistedSourceOccurrenceKey =
      normalizeString(match.existingEvent.sourceOccurrenceKey) ||
      readJsonString(normalizedFields, "sourceOccurrenceKey");
    const occurrenceKey =
      persistedSourceOccurrenceKey ||
      [
        "legacy",
        normalizeString(match.existingEvent.date),
        getSourceOccurrenceProvenanceKey(normalizedFields) ?? "missing-row",
        normalizeEventTime(match.existingEvent.time).startLabel ||
          normalizeString(match.existingEvent.time).toLowerCase() ||
          "unknown-time",
        readJsonNumber(normalizedFields, "splitEventIndex") ??
          readJsonNumber(normalizedFields, "expandedDateIndex") ??
          "unknown-index",
      ].join("|");
    persistedOccurrenceKeys.add(occurrenceKey);

    const rowExpectedKeys = readJsonStringArray(
      normalizedFields,
      "sourceOccurrenceExpectedKeys",
    );
    if (
      !persistedSourceOccurrenceKey?.startsWith("instagram-occurrence-v2:") ||
      rowExpectedKeys.length !== rowExpectedCount ||
      new Set(rowExpectedKeys).size !== rowExpectedKeys.length
    ) {
      allTrackedRowsHaveExactV2Metadata = false;
      continue;
    }
    const rowExpectedKeySignature = JSON.stringify([...rowExpectedKeys].sort());
    if (expectedKeySignature === null) {
      expectedKeySignature = rowExpectedKeySignature;
      expectedKeySet = new Set(rowExpectedKeys);
    } else if (expectedKeySignature !== rowExpectedKeySignature) {
      return true;
    }
  }

  if (expectedKeySet) {
    if (!allTrackedRowsHaveExactV2Metadata) {
      return true;
    }
    return (
      persistedOccurrenceKeys.size !== expectedKeySet.size ||
      [...expectedKeySet].some((key) => !persistedOccurrenceKeys.has(key))
    );
  }

  return expectedOccurrenceCount > 1 && persistedOccurrenceKeys.size < expectedOccurrenceCount;
}

function buildSourceOccurrenceKeyFromFields(
  post: InstagramScrapedPost,
  date: string,
  time: string | undefined,
  normalizedFields: Record<string, unknown>,
): string {
  const sourceIdentity = buildSourceOccurrenceIdentity(post);
  const canonicalTime = normalizeEventTime(time);
  const comparableTime =
    canonicalTime.startLabel ?? extractComparableTimeParts(time)[0] ?? "";
  const collisionOrdinal = readJsonNumber(
    normalizedFields,
    "sourceOccurrenceCollisionOrdinal",
  );
  const occurrenceIdentity = isDateRangeExpandedNormalizedFields(normalizedFields)
    ? `${date}|date-range`
    : isMultiOccurrenceNormalizedFields(normalizedFields)
      ? `${date}|row:time:${
          comparableTime || normalizeString(time).toLowerCase() || "unknown"
        }${collisionOrdinal === null ? "" : `|collision-ordinal:${collisionOrdinal}`}`
      : `${date}|single`;
  const digest = createHash("sha256")
    .update(`instagram-occurrence-v2\u0000${sourceIdentity}\u0000${occurrenceIdentity}`)
    .digest("hex");
  return `instagram-occurrence-v2:${digest}`;
}

export function buildSourceOccurrenceKeyForTesting(
  post: InstagramScrapedPost,
  date: string,
  time: string | undefined,
  normalizedFields: Record<string, unknown>,
): string {
  return buildSourceOccurrenceKeyFromFields(post, date, time, normalizedFields);
}

type OccurrenceBindingInput = {
  date?: string;
  deferred: boolean;
  kind: "event" | "skip";
  normalizedFields: Record<string, unknown>;
  time?: string;
};

type OccurrenceBinding = {
  ambiguous: boolean;
  normalizedFields: Record<string, unknown>;
  sourceOccurrenceKey: string | null;
};

function calculateSourceOccurrenceBindings(
  post: InstagramScrapedPost,
  inputs: readonly OccurrenceBindingInput[],
): OccurrenceBinding[] {
  const buildKeyForInput = (
    input: OccurrenceBindingInput,
    normalizedFields: Record<string, unknown>,
  ): string | null => {
    const date =
      input.kind === "event"
        ? input.date
        : readJsonString(normalizedFields, "normalizedDate");
    if (!date) {
      return null;
    }
    return buildSourceOccurrenceKeyFromFields(
      post,
      date,
      input.kind === "event"
        ? input.time
        : readJsonString(normalizedFields, "time") ?? undefined,
      normalizedFields,
    );
  };
  const baseOccurrenceKeys = inputs.map((input) =>
    buildKeyForInput(input, input.normalizedFields),
  );
  const baseKeyCounts = new Map<string, number>();
  for (const key of baseOccurrenceKeys) {
    if (key) {
      baseKeyCounts.set(key, (baseKeyCounts.get(key) ?? 0) + 1);
    }
  }
  const seenBaseKeyCounts = new Map<string, number>();
  const occurrenceNormalizedFields = inputs.map((input, index) => {
    const baseKey = baseOccurrenceKeys[index];
    if (!baseKey || (baseKeyCounts.get(baseKey) ?? 0) < 2) {
      return input.normalizedFields;
    }
    const collisionOrdinal = (seenBaseKeyCounts.get(baseKey) ?? 0) + 1;
    seenBaseKeyCounts.set(baseKey, collisionOrdinal);
    return {
      ...input.normalizedFields,
      sourceOccurrenceCollisionOrdinal: collisionOrdinal,
      sourceOccurrenceAmbiguousProvenance: true,
    };
  });
  const sourceOccurrenceKeys = inputs.map((input, index) =>
    buildKeyForInput(input, occurrenceNormalizedFields[index]!),
  );
  const persistableOccurrenceKeys = sourceOccurrenceKeys
    .filter(
      (key, index): key is string => inputs[index]?.kind === "event" && key !== null,
    )
    .sort();
  const persistableOccurrenceCount = persistableOccurrenceKeys.length;
  const deferredChildCount = inputs.filter((input) => input.deferred).length;
  const sourceFingerprint = buildSourceOccurrenceFingerprint(post);

  return inputs.map((input, index) => {
    const sourceOccurrenceKey = sourceOccurrenceKeys[index];
    const occurrenceFields = occurrenceNormalizedFields[index] ?? input.normalizedFields;
    if (input.kind !== "event" || !sourceOccurrenceKey) {
      return {
        ambiguous: occurrenceFields.sourceOccurrenceAmbiguousProvenance === true,
        normalizedFields: sourceOccurrenceKey
          ? { ...occurrenceFields, sourceOccurrenceKey }
          : occurrenceFields,
        sourceOccurrenceKey,
      };
    }
    const normalizedFields: Record<string, unknown> = {
      ...occurrenceFields,
      sourceOccurrenceSourceFingerprint: sourceFingerprint,
      ...(isMultiOccurrenceNormalizedFields(occurrenceFields)
        ? {
            sourceOccurrenceExpectedCount: persistableOccurrenceCount,
            sourceOccurrenceExpectedKeys: persistableOccurrenceKeys,
            sourceOccurrenceDeferredChildCount: deferredChildCount,
          }
        : {}),
      sourceOccurrenceKey,
    };
    const hasAmbiguousOccurrenceProvenance =
      normalizedFields.sourceOccurrenceAmbiguousProvenance === true;
    if (hasAmbiguousOccurrenceProvenance) {
      normalizedFields.moderationAutoApproved = false;
      normalizedFields.moderationAutoApproveRule = null;
      normalizedFields.moderationPendingReasons = [
        ...new Set([
          ...((normalizedFields.moderationPendingReasons as string[] | undefined) ?? []),
          "ambiguous_source_occurrence_provenance",
        ]),
      ];
    }
    return {
      ambiguous: hasAmbiguousOccurrenceProvenance,
      normalizedFields,
      sourceOccurrenceKey,
    };
  });
}

/** Fact-native occurrence binding used by the ingestion runtime. */
export function bindSourceOccurrenceFactMetadata<
  T extends SourceOccurrenceFactResult,
>(
  post: InstagramScrapedPost,
  factResults: readonly T[],
): T[] {
  const bindings = calculateSourceOccurrenceBindings(
    post,
    factResults.map((result) =>
      result.kind === "event"
        ? {
            kind: "event" as const,
            date: result.facts.localDate,
            time: getStructuredFactsOccurrenceTime(result.facts),
            deferred: false,
            normalizedFields: result.normalizedFields,
          }
        : {
            kind: "skip" as const,
            deferred: result.reason !== "past_event",
            normalizedFields: result.normalizedFields,
          },
    ),
  );
  return factResults.map((result, index) => {
    const binding = bindings[index];
    if (!binding) {
      throw new Error("Source-occurrence fact binding lost a result row.");
    }
    if (result.kind === "skip") {
      return {
        ...result,
        normalizedFields: binding.normalizedFields,
      } as T;
    }
    if (!binding.ambiguous) {
      return {
        ...result,
        normalizedFields: binding.normalizedFields,
      } as T;
    }
    const policy = result.facts.policy;
    return {
      ...result,
      normalizedFields: binding.normalizedFields,
      facts: {
        ...result.facts,
        policy: {
          approvalDisposition: "pending",
          pendingReasons: readJsonStringArray(
            binding.normalizedFields,
            "moderationPendingReasons",
          ),
          signals:
            readJsonStringArray(binding.normalizedFields, "moderationSignals").length > 0
              ? readJsonStringArray(binding.normalizedFields, "moderationSignals")
              : [...policy.signals],
          structuredEvidenceVerified: policy.structuredEvidenceVerified,
        },
      },
    } as T;
  });
}

/** Compatibility adapter for callers that still produce persistence events. */
export function bindSourceOccurrenceMetadata<T extends OccurrencePrepareResult>(
  post: InstagramScrapedPost,
  preparedResults: T[],
): T[] {
  const bindings = calculateSourceOccurrenceBindings(
    post,
    preparedResults.map((prepared) =>
      prepared.kind === "ok"
        ? {
            kind: "event" as const,
            date: prepared.event.date,
            time: prepared.event.time,
            deferred: false,
            normalizedFields: prepared.normalizedFields,
          }
        : {
            kind: "skip" as const,
            deferred: prepared.reason !== "past_event",
            normalizedFields: prepared.normalizedFields,
          },
    ),
  );
  return preparedResults.map((prepared, index) => {
    const binding = bindings[index];
    if (!binding) {
      throw new Error("Source-occurrence compatibility binding lost a result row.");
    }
    if (prepared.kind !== "ok" || !binding.sourceOccurrenceKey) {
      return {
        ...prepared,
        normalizedFields: binding.normalizedFields,
      } as T;
    }
    return {
      ...prepared,
      normalizedFields: binding.normalizedFields,
      event: {
        ...prepared.event,
        ...(binding.ambiguous ? { status: "pending" } : {}),
        sourceOccurrenceKey: binding.sourceOccurrenceKey,
        normalizedFieldsJson: JSON.stringify(binding.normalizedFields),
      },
    } as T;
  });
}

function buildSourceOccurrenceChildTrackingKeyFromFields(
  post: InstagramScrapedPost,
  normalizedFields: Record<string, unknown>,
  index: number,
): string {
  const isMultiOccurrence = isMultiOccurrenceNormalizedFields(normalizedFields);
  const date = readJsonString(normalizedFields, "normalizedDate");
  const rawTime = readJsonString(normalizedFields, "time") ?? undefined;
  const normalizedTime = rawTime
    ? normalizeEventTime(rawTime).startLabel ??
      extractComparableTimeParts(rawTime)[0] ??
      normalizeString(rawTime).toLowerCase()
    : null;
  const hasStructuralIdentity = Boolean(date || normalizedTime);
  const title = hasStructuralIdentity
    ? null
    : toSearchableText(readJsonString(normalizedFields, "title") ?? "") || null;
  const venue = hasStructuralIdentity
    ? null
    : toSearchableText(readJsonString(normalizedFields, "venue") ?? "") || null;
  const artists = hasStructuralIdentity
    ? []
    : readJsonStringArray(normalizedFields, "artists")
        .map((artist) => toSearchableText(artist))
        .filter(Boolean)
        .sort();
  const hasFallbackSemanticIdentity = Boolean(title || venue || artists.length > 0);
  const identity = isMultiOccurrence
    ? {
        kind: "multi",
        date,
        time: normalizedTime,
        title,
        venue,
        artists,
        expandedDateIndex: readJsonNumber(normalizedFields, "expandedDateIndex"),
        collisionOrdinal: readJsonNumber(
          normalizedFields,
          "sourceOccurrenceCollisionOrdinal",
        ),
        fallbackSplitEventIndex:
          hasStructuralIdentity || hasFallbackSemanticIdentity
            ? null
            : readJsonNumber(normalizedFields, "splitEventIndex"),
        fallbackIndex:
          hasStructuralIdentity || hasFallbackSemanticIdentity ? null : index,
      }
    : { kind: "single" };
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        sourceIdentity: buildSourceOccurrenceIdentity(post),
        identity,
      }),
    )
    .digest("hex");
  return `instagram-source-child-v1:${digest}`;
}

export function buildSourceOccurrenceChildTrackingKeyForTesting(
  post: InstagramScrapedPost,
  prepared: OccurrencePrepareResult,
  index: number,
): string {
  return buildSourceOccurrenceChildTrackingKeyFromFields(
    post,
    prepared.normalizedFields,
    index,
  );
}

type SourceOccurrencePlanInput =
  | {
      kind: "event";
      normalizedFields: Record<string, unknown>;
      expected: Omit<
        SourceOccurrencePlan["expectedOccurrences"][number],
        "key"
      >;
    }
  | {
      kind: "skip";
      normalizedFields: Record<string, unknown>;
      reason: string;
    };

function buildSourceOccurrencePlanFromInputs(
  post: InstagramScrapedPost,
  inputs: readonly SourceOccurrencePlanInput[],
): SourceOccurrencePlan | null {
  const successfulInputs = inputs.filter(
    (input): input is Extract<SourceOccurrencePlanInput, { kind: "event" }> =>
      input.kind === "event",
  );
  const expectedKeys = successfulInputs
    .map((input) => readJsonString(input.normalizedFields, "sourceOccurrenceKey"))
    .filter((key): key is string => key !== null);
  const expectedOccurrences = successfulInputs
    .map((input) => ({
      ...input.expected,
      key: readJsonString(input.normalizedFields, "sourceOccurrenceKey"),
    }))
    .filter(
      (occurrence): occurrence is SourceOccurrencePlan["expectedOccurrences"][number] =>
        occurrence.key !== null,
    );
  if (inputs.length === 0 || new Set(expectedKeys).size !== expectedKeys.length) {
    return null;
  }
  const observedChildKeys = inputs.map((input, index) =>
    buildSourceOccurrenceChildTrackingKeyFromFields(
      post,
      input.normalizedFields,
      index,
    ),
  );
  const deferredChildKeys = inputs
    .map((input, index) => ({ input, key: observedChildKeys[index]! }))
    .filter(
      ({ input }) => input.kind === "skip" && input.reason !== "past_event",
    )
    .map(({ key }) => key);
  if (
    new Set(observedChildKeys).size !== observedChildKeys.length ||
    new Set(deferredChildKeys).size !== deferredChildKeys.length
  ) {
    return null;
  }
  return {
    sourceIdentity: buildSourceOccurrenceIdentity(post),
    sourceFingerprint: buildSourceOccurrenceFingerprint(post),
    expectedKeys,
    expectedOccurrences,
    deferredChildCount: deferredChildKeys.length,
    deferredChildKeys,
    observedChildKeys,
  };
}

/** Build a durable source plan directly from typed facts. */
export function buildSourceOccurrencePlanFromFacts(
  post: InstagramScrapedPost,
  factResults: readonly SourceOccurrenceFactResult[],
): SourceOccurrencePlan | null {
  return buildSourceOccurrencePlanFromInputs(
    post,
    factResults.map((result) =>
      result.kind === "event"
        ? {
            kind: "event" as const,
            normalizedFields: result.normalizedFields,
            expected: {
              artists: [...result.facts.artistClaims],
              date: result.facts.localDate,
              time: getStructuredFactsOccurrenceTime(result.facts),
              title: result.facts.titleClaim,
              venue: result.facts.venueClaim ?? "",
              factsJson: serializeStructuredFacts(result.facts),
              ...(result.canonicalEvent
                ? {
                    canonicalEventJson: serializeCanonicalEventPayload(
                      result.canonicalEvent,
                    ),
                  }
                : {}),
            },
          }
        : {
            kind: "skip" as const,
            normalizedFields: result.normalizedFields,
            reason: result.reason,
          },
    ),
  );
}

/** Compatibility adapter for legacy prepared-event callers. */
export function buildSourceOccurrencePlan(
  post: InstagramScrapedPost,
  preparedResults: OccurrencePrepareResult[],
): SourceOccurrencePlan | null {
  return buildSourceOccurrencePlanFromInputs(
    post,
    preparedResults.map((prepared) =>
      prepared.kind === "ok"
        ? {
            kind: "event" as const,
            normalizedFields: prepared.normalizedFields,
            expected: {
              artists: prepared.event.artists,
              date: prepared.event.date,
              ...(prepared.event.time ? { time: prepared.event.time } : {}),
              title: prepared.event.title,
              venue: prepared.event.venue,
            },
          }
        : {
            kind: "skip" as const,
            normalizedFields: prepared.normalizedFields,
            reason: prepared.reason,
          },
    ),
  );
}

export function isCompleteSourceOccurrenceReceipt(
  value: unknown,
  post: InstagramScrapedPost,
): value is SourceOccurrenceReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const receipt = value as Partial<SourceOccurrenceReceipt>;
  return (
    receipt.sourceIdentity === buildSourceOccurrenceIdentity(post) &&
    receipt.sourceFingerprint === buildSourceOccurrenceFingerprint(post) &&
    Array.isArray(receipt.expectedKeys) &&
    new Set(receipt.expectedKeys).size === receipt.expectedKeys.length &&
    Array.isArray(receipt.satisfiedKeys) &&
    Array.isArray(receipt.satisfiedOccurrences) &&
    receipt.satisfiedOccurrences.every(
      (occurrence) =>
        occurrence &&
        typeof occurrence === "object" &&
        typeof occurrence.key === "string" &&
        typeof occurrence.eventId === "string",
    ) &&
    new Set(receipt.satisfiedOccurrences.map((occurrence) => occurrence.eventId)).size ===
      receipt.satisfiedOccurrences.length &&
    Array.isArray(receipt.deferredChildKeys) &&
    new Set(receipt.deferredChildKeys).size === receipt.deferredChildKeys.length &&
    Number.isInteger(receipt.deferredChildCount) &&
    receipt.deferredChildCount === receipt.deferredChildKeys.length &&
    receipt.deferredChildCount === 0 &&
    receipt.expectedKeys.every((key) => receipt.satisfiedKeys?.includes(key))
  );
}
