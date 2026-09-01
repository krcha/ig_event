import {
  MAX_STRUCTURED_FACTS_JSON_LENGTH,
  parseStructuredFactsJson,
} from "../../lib/domain/occurrences/facts";
import { parseCanonicalEventPayload } from "../../lib/domain/occurrences/canonical-event-payload";

export { MAX_STRUCTURED_FACTS_JSON_LENGTH };
export const MAX_SOURCE_OCCURRENCE_KEYS_PER_SOURCE = 64;
export const MAX_SOURCE_OCCURRENCE_ARTISTS = 64;
export const MAX_SOURCE_OCCURRENCE_STRING_LENGTH = 4_096;
// Bounded recurring schedules can carry one verified canonical payload per
// child. Keep the aggregate below half a MiB (well inside Convex's document
// limit) while allowing the reviewed 25-occurrence schedule shape.
export const MAX_SOURCE_OCCURRENCE_SERIALIZED_PAYLOAD_LENGTH = 512_000;
export const MAX_CANONICAL_EVENT_JSON_LENGTH = 100_000;

export type BoundedExpectedOccurrence = {
  artists: string[];
  canonicalEventJson?: string;
  date: string;
  key: string;
  time?: string;
  title: string;
  venue: string;
  factsJson?: string;
};

export type SourceOccurrenceSyncPlanBoundsInput = {
  confirmedPastKeys?: string[];
  deferredChildKeys: string[];
  expectedKeys: string[];
  expectedOccurrences: BoundedExpectedOccurrence[];
  sourceFingerprint: string;
  sourceIdentity: string;
};

export function isSourceOccurrenceBoundedString(
  value: unknown,
  allowEmpty = false,
): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_SOURCE_OCCURRENCE_STRING_LENGTH &&
    (allowEmpty || value.trim().length > 0)
  );
}

export function sourceOccurrenceBindingWithinBounds(
  occurrence: BoundedExpectedOccurrence,
): boolean {
  const facts = occurrence?.factsJson
    ? parseStructuredFactsJson(occurrence.factsJson)
    : null;
  return (
    occurrence !== null &&
    typeof occurrence === "object" &&
    isSourceOccurrenceBoundedString(occurrence.key) &&
    isSourceOccurrenceBoundedString(occurrence.date) &&
    (occurrence.time === undefined ||
      isSourceOccurrenceBoundedString(occurrence.time)) &&
    // Event-evidence v2 intentionally persists an unknown venue as "".
    isSourceOccurrenceBoundedString(occurrence.venue, true) &&
    isSourceOccurrenceBoundedString(occurrence.title) &&
    Array.isArray(occurrence.artists) &&
    occurrence.artists.length <= MAX_SOURCE_OCCURRENCE_ARTISTS &&
    occurrence.artists.every((artist) =>
      isSourceOccurrenceBoundedString(artist),
    ) &&
    (occurrence.canonicalEventJson === undefined ||
      (occurrence.canonicalEventJson.length <=
        MAX_CANONICAL_EVENT_JSON_LENGTH &&
        parseCanonicalEventPayload(occurrence.canonicalEventJson) !== null)) &&
    (occurrence.factsJson === undefined ||
      (occurrence.factsJson.length <= MAX_STRUCTURED_FACTS_JSON_LENGTH &&
        facts !== null))
  );
}

export function sourceOccurrenceArrayHasUniqueBoundedStrings(
  values: unknown,
): values is string[] {
  return (
    Array.isArray(values) &&
    values.length <= MAX_SOURCE_OCCURRENCE_KEYS_PER_SOURCE &&
    values.every((value) => isSourceOccurrenceBoundedString(value)) &&
    new Set(values).size === values.length
  );
}

export function sourceOccurrenceSerializedPayloadWithinBounds(
  value: unknown,
): boolean {
  try {
    const serialized = JSON.stringify(value);
    return (
      new TextEncoder().encode(serialized).byteLength <=
      MAX_SOURCE_OCCURRENCE_SERIALIZED_PAYLOAD_LENGTH
    );
  } catch {
    return false;
  }
}

/** Hard fence applied before any first-class occurrence rows are synchronized. */
export function assertSourceOccurrenceSyncPlanWithinBounds(
  plan: SourceOccurrenceSyncPlanBoundsInput,
): void {
  if (
    !plan ||
    !isSourceOccurrenceBoundedString(plan.sourceIdentity) ||
    !isSourceOccurrenceBoundedString(plan.sourceFingerprint) ||
    !sourceOccurrenceArrayHasUniqueBoundedStrings(plan.expectedKeys) ||
    !Array.isArray(plan.expectedOccurrences) ||
    plan.expectedOccurrences.length > MAX_SOURCE_OCCURRENCE_KEYS_PER_SOURCE ||
    !plan.expectedOccurrences.every(sourceOccurrenceBindingWithinBounds) ||
    !sourceOccurrenceArrayHasUniqueBoundedStrings(plan.deferredChildKeys) ||
    (plan.confirmedPastKeys !== undefined &&
      !sourceOccurrenceArrayHasUniqueBoundedStrings(plan.confirmedPastKeys)) ||
    !sourceOccurrenceSerializedPayloadWithinBounds(plan)
  ) {
    throw new Error("Source occurrence synchronization plan exceeds its hard bounds.");
  }
  const expectedOccurrenceKeys = plan.expectedOccurrences.map(
    (occurrence) => occurrence.key,
  );
  const expectedKeySet = new Set(plan.expectedKeys);
  const deferredKeySet = new Set(plan.deferredChildKeys);
  const confirmedPastKeySet = new Set(plan.confirmedPastKeys ?? []);
  const allKeys = new Set([
    ...plan.expectedKeys,
    ...expectedOccurrenceKeys,
    ...plan.deferredChildKeys,
    ...(plan.confirmedPastKeys ?? []),
  ]);
  if (
    plan.expectedOccurrences.length !== plan.expectedKeys.length ||
    new Set(expectedOccurrenceKeys).size !== expectedOccurrenceKeys.length ||
    expectedOccurrenceKeys.some((key) => !expectedKeySet.has(key)) ||
    plan.deferredChildKeys.some((key) => expectedKeySet.has(key)) ||
    [...confirmedPastKeySet].some(
      (key) => expectedKeySet.has(key) || deferredKeySet.has(key),
    ) ||
    allKeys.size > MAX_SOURCE_OCCURRENCE_KEYS_PER_SOURCE
  ) {
    throw new Error("Source occurrence synchronization plan is internally inconsistent.");
  }
}
