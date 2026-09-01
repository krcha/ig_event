import { normalizeEventTime } from "@/lib/events/event-time";
import { sourceOccurrenceRepresentativeMatchesExpected } from "@/lib/events/source-occurrence-representation";
import { normalizeHandle, toSearchableText } from "@/lib/pipeline/venue-normalization";
import { type InstagramScrapedPost } from "@/lib/scraper/instagram-scraper";
import { ConvexHttpClient } from "convex/browser";
import type { ExistingEventRecord, ExistingSourceMatch, IngestionStep, PrepareEventResult, PreparedEvent } from "@/lib/pipeline/ingestion/contracts";
import { getByInstagramPostIdQuery, getByInstagramPostUrlQuery, listByInstagramPostIdQuery, listByInstagramPostUrlQuery, listCandidatesForNormalizedOccurrenceQuery } from "@/lib/pipeline/ingestion/convex-bindings";
import { getPostContext } from "@/lib/pipeline/ingestion/media-durability";
import { allowsDateOnlySourceIdentityMatch, areTimesCompatible, extractComparableTimeParts, getComparableArtistCandidates, getComparableTitleCandidates, getSemanticDuplicateMatchScore, hasReliableEventTime, isDateRangeExpandedNormalizedFields, isMultiOccurrenceNormalizedFields } from "@/lib/pipeline/ingestion/occurrence-comparison";
import { getErrorMessage, isIncompleteSourceIdentityLookup, logError } from "@/lib/pipeline/ingestion/runtime";
import { extractShortcodeFromPostUrl } from "@/lib/pipeline/ingestion/source-documents";
import { normalizeString, parseJsonRecord, readJsonString } from "@/lib/pipeline/ingestion/values";

/**
 * This selector is a compatibility authority only for the legacy ingestion
 * write path. It assigns ambiguous multi-row receipt keys and permits the
 * narrowly fenced `allowUnverifiedPending` representative check before the
 * generic executor owns the write. Those operations are intentionally absent
 * from the canonical occurrence-relation strategy, so calling that strategy
 * here would change retry/idempotency behavior rather than share an invariant.
 */
export const LEGACY_INGESTION_OCCURRENCE_MATCHER_CLASSIFICATION =
  "compatibility_pre_generic_reconciliation_apply_cutover" as const;

/**
 * Concrete retirement gate: the production reconciliation rollout must have
 * clean full-outcome evidence and reviewed create/attach/update capability, and
 * ingestion must atomically write through executeSourceOccurrence. Until all
 * three operations cross that cutover, this module must remain isolated to the
 * legacy ingestion persister and must not become a moderation/merge authority.
 */
export const LEGACY_INGESTION_OCCURRENCE_MATCHER_CUTOVER_CONDITION =
  "source-occurrence-reconciliation-apply-v1 reviewed for create, attach, and update; ingestion writes switched atomically to reconciliation:executeSourceOccurrence" as const;

export async function listExistingEventsBySourceIdentity(
  client: ConvexHttpClient,
  post: InstagramScrapedPost,
  serviceSecret: string,
): Promise<ExistingSourceMatch[]> {
  const postContext = getPostContext(normalizeHandle(post.username), post);
  const matchesById = new Map<string, ExistingSourceMatch>();

  const loadMatchesByPostId = async (
    candidate: string,
    matchedBy: "post_id" | "shortcode",
  ): Promise<ExistingSourceMatch[]> => {
    try {
      const records = (await client.query(listByInstagramPostIdQuery, {
        instagramPostId: candidate,
        serviceSecret,
      })) as ExistingEventRecord[];
      return records.map((existingEvent) => ({
        existingEvent,
        matchedBy,
        matchedValue: candidate,
      }));
    } catch (listError) {
      logError("ingestion.duplicate_lookup.list_failed", {
        step: "duplicate_lookup" satisfies IngestionStep,
        lookup: "events:listByInstagramPostId",
        ...postContext,
        candidate,
        matchedBy,
        error: getErrorMessage(listError),
      });

      // The single-row compatibility lookup is useful for a transient query
      // failure, but it must never turn an explicitly incomplete bounded
      // result into a false unique match.
      if (isIncompleteSourceIdentityLookup(listError)) {
        throw listError;
      }

      try {
        const fallback = (await client.query(getByInstagramPostIdQuery, {
          instagramPostId: candidate,
          serviceSecret,
        })) as ExistingEventRecord | null;
        if (!fallback) {
          return [];
        }
        return [
          {
            existingEvent: fallback,
            matchedBy,
            matchedValue: candidate,
          },
        ];
      } catch (fallbackError) {
        logError("ingestion.duplicate_lookup.fallback_failed", {
          step: "duplicate_lookup" satisfies IngestionStep,
          lookup: "events:getByInstagramPostId",
          ...postContext,
          candidate,
          matchedBy,
          error: getErrorMessage(fallbackError),
        });
        throw fallbackError;
      }
    }
  };

  const loadMatchesByPostUrl = async (postUrl: string): Promise<ExistingSourceMatch[]> => {
    try {
      const records = (await client.query(listByInstagramPostUrlQuery, {
        instagramPostUrl: postUrl,
        serviceSecret,
      })) as ExistingEventRecord[];
      return records.map((existingEvent) => ({
        existingEvent,
        matchedBy: "post_url" as const,
        matchedValue: postUrl,
      }));
    } catch (listError) {
      logError("ingestion.duplicate_lookup.list_failed", {
        step: "duplicate_lookup" satisfies IngestionStep,
        lookup: "events:listByInstagramPostUrl",
        ...postContext,
        postUrl,
        matchedBy: "post_url",
        error: getErrorMessage(listError),
      });

      if (isIncompleteSourceIdentityLookup(listError)) {
        throw listError;
      }

      try {
        const fallback = (await client.query(getByInstagramPostUrlQuery, {
          instagramPostUrl: postUrl,
          serviceSecret,
        })) as ExistingEventRecord | null;
        if (!fallback) {
          return [];
        }
        return [
          {
            existingEvent: fallback,
            matchedBy: "post_url",
            matchedValue: postUrl,
          },
        ];
      } catch (fallbackError) {
        logError("ingestion.duplicate_lookup.fallback_failed", {
          step: "duplicate_lookup" satisfies IngestionStep,
          lookup: "events:getByInstagramPostUrl",
          ...postContext,
          postUrl,
          matchedBy: "post_url",
          error: getErrorMessage(fallbackError),
        });
        throw fallbackError;
      }
    }
  };

  const identityCandidates = new Set<string>();
  if (post.postId) {
    identityCandidates.add(post.postId);
  }
  const shortcode = extractShortcodeFromPostUrl(post.instagramPostUrl);
  if (shortcode) {
    identityCandidates.add(shortcode);
  }

  for (const candidate of identityCandidates) {
    const matchedBy = candidate === post.postId ? "post_id" : "shortcode";
    const matches = await loadMatchesByPostId(candidate, matchedBy);
    for (const match of matches) {
      matchesById.set(match.existingEvent._id, match);
    }
  }

  const postUrl = normalizeString(post.instagramPostUrl);
  if (postUrl) {
    const matches = await loadMatchesByPostUrl(postUrl);
    for (const match of matches) {
      matchesById.set(match.existingEvent._id, match);
    }
  }

  return [...matchesById.values()];
}

export const listExistingEventsBySourceIdentityForTesting =
  listExistingEventsBySourceIdentity;

export async function listExistingEventsByPreparedDates(
  client: ConvexHttpClient,
  post: InstagramScrapedPost,
  preparedResults: PrepareEventResult[],
  serviceSecret: string,
): Promise<ExistingSourceMatch[]> {
  const postContext = getPostContext(normalizeHandle(post.username), post);
  const matchesById = new Map<string, ExistingSourceMatch>();
  const preparedOccurrences = preparedResults.filter(
    (prepared): prepared is Extract<PrepareEventResult, { kind: "ok" }> =>
      prepared.kind === "ok",
  );

  for (const prepared of preparedOccurrences) {
    try {
      const venueInstagramHandle = readJsonString(
        prepared.normalizedFields,
        "canonicalVenueEvidenceHandle",
      );
      const result = (await client.query(listCandidatesForNormalizedOccurrenceQuery, {
        artists: prepared.event.artists,
        date: prepared.event.date,
        eventType: prepared.event.eventType,
        limit: 25,
        serviceSecret,
        ...(prepared.event.time ? { time: prepared.event.time } : {}),
        title: prepared.event.title,
        venue: prepared.event.venue,
        ...(venueInstagramHandle ? { venueInstagramHandle } : {}),
      })) as {
        candidates: ExistingEventRecord[];
        complete: boolean;
        venueResolutionStatus: "resolved" | "ambiguous" | "unresolved";
      };
      if (!result.complete || result.venueResolutionStatus === "ambiguous") {
        throw new Error(
          result.venueResolutionStatus === "ambiguous"
            ? "Venue resolution is ambiguous during indexed duplicate lookup."
            : "Indexed duplicate candidate set exceeded its safe bound.",
        );
      }
      for (const existingEvent of result.candidates) {
        if (matchesById.has(existingEvent._id)) {
          continue;
        }
        matchesById.set(existingEvent._id, {
          existingEvent,
          matchedBy: "same_date_semantic",
          matchedValue: prepared.event.date,
        });
      }
    } catch (error) {
      logError("ingestion.duplicate_lookup.list_failed", {
        step: "duplicate_lookup" satisfies IngestionStep,
        lookup: "sourceOccurrences:listCandidatesForNormalizedOccurrence",
        ...postContext,
        date: prepared.event.date,
        matchedBy: "same_date_semantic",
        error: getErrorMessage(error),
      });
      throw error;
    }
  }

  return [...matchesById.values()];
}

export function normalizeTitleKey(value: string | undefined): string {
  return normalizeString(value).toLowerCase().replace(/\s+/g, " ");
}

export function getSourceOccurrenceProvenanceKey(
  normalizedFields: Record<string, unknown> | null,
): string | null {
  const rowSourceText =
    readJsonString(normalizedFields, "rowSourceText") ??
    readJsonString(normalizedFields, "splitSourceLine");
  const normalizedRowSourceText = toSearchableText(rowSourceText ?? "");
  if (!normalizedRowSourceText) {
    return null;
  }

  return normalizedRowSourceText;
}

export function hasCompatibleSourceOccurrenceIdentity(
  existing: ExistingEventRecord,
  next: PreparedEvent,
  nextNormalizedFields: Record<string, unknown>,
): boolean {
  const existingNormalizedFields = parseJsonRecord(existing.normalizedFieldsJson);
  const existingOccurrenceKey =
    normalizeString(existing.sourceOccurrenceKey) ||
    readJsonString(existingNormalizedFields, "sourceOccurrenceKey");
  const nextOccurrenceKey = readJsonString(nextNormalizedFields, "sourceOccurrenceKey");
  if (
    existingOccurrenceKey?.startsWith("instagram-occurrence-v2:") &&
    nextOccurrenceKey?.startsWith("instagram-occurrence-v2:")
  ) {
    return existingOccurrenceKey === nextOccurrenceKey;
  }
  if (
    !isMultiOccurrenceNormalizedFields(existingNormalizedFields) &&
    !isMultiOccurrenceNormalizedFields(nextNormalizedFields)
  ) {
    return true;
  }

  const existingIsDateRange = isDateRangeExpandedNormalizedFields(existingNormalizedFields);
  const nextIsDateRange = isDateRangeExpandedNormalizedFields(nextNormalizedFields);
  if (existingIsDateRange || nextIsDateRange) {
    return (
      existingIsDateRange &&
      nextIsDateRange &&
      normalizeString(existing.date) === normalizeString(next.date)
    );
  }

  const existingHasReliableTime = hasReliableEventTime(existing);
  const nextHasReliableTime = hasReliableEventTime(next);
  if (
    existingHasReliableTime &&
    nextHasReliableTime &&
    !areTimesCompatible(existing.time, next.time)
  ) {
    return false;
  }

  const existingProvenanceKey = getSourceOccurrenceProvenanceKey(existingNormalizedFields);
  const nextProvenanceKey = getSourceOccurrenceProvenanceKey(nextNormalizedFields);
  if (existingProvenanceKey && nextProvenanceKey) {
    return existingProvenanceKey === nextProvenanceKey;
  }

  return (
    existingHasReliableTime &&
    nextHasReliableTime &&
    areTimesCompatible(existing.time, next.time)
  );
}

export function findBestExistingMatchForPreparedEvent(
  existingMatches: ExistingSourceMatch[],
  nextEvent: PreparedEvent,
  nextNormalizedFields: Record<string, unknown>,
): ExistingSourceMatch | null {
  const nextOccurrenceKey = readJsonString(
    nextNormalizedFields,
    "sourceOccurrenceKey",
  );
  if (nextOccurrenceKey) {
    const expectedOccurrence = {
      key: nextOccurrenceKey,
      date: nextEvent.date,
      ...(nextEvent.time ? { time: nextEvent.time } : {}),
      venue: nextEvent.venue,
      title: nextEvent.title,
      artists: nextEvent.artists,
    };
    // Duplicate scoring may locate a plausible candidate, but only the same
    // semantic predicate used by the atomic Convex receipt write may select a
    // representative. This prevents a fuzzy same-date/source match from being
    // sent to a mutation that must reject it (or from rebinding an ordinal key).
    existingMatches = existingMatches.filter((existing) =>
      sourceOccurrenceRepresentativeMatchesExpected(
        existing.existingEvent,
        expectedOccurrence,
        { allowUnverifiedPending: true },
      ),
    );
  }
  const sourceIdentityMatches = existingMatches.filter(
    (existing) => existing.matchedBy !== "same_date_semantic",
  );
  const nextHasAmbiguousProvenance =
    nextNormalizedFields.sourceOccurrenceAmbiguousProvenance === true;
  if (nextHasAmbiguousProvenance) {
    let bestCollisionMatch: ExistingSourceMatch | null = null;
    let bestCollisionScore = 0;
    let bestCollisionScoreCount = 0;
    for (const existing of sourceIdentityMatches) {
      const existingNormalizedFields = parseJsonRecord(
        existing.existingEvent.normalizedFieldsJson,
      );
      if (
        !existingNormalizedFields ||
        existingNormalizedFields.sourceOccurrenceAmbiguousProvenance !== true ||
        normalizeString(existing.existingEvent.date) !== nextEvent.date ||
        !areTimesCompatible(existing.existingEvent.time, nextEvent.time)
      ) {
        continue;
      }
      const existingTitles = new Set(
        getComparableTitleCandidates(existing.existingEvent, existingNormalizedFields),
      );
      const existingArtists = new Set(
        getComparableArtistCandidates(existing.existingEvent),
      );
      const titleMatches = getComparableTitleCandidates(
        nextEvent,
        nextNormalizedFields,
      ).some((value) => existingTitles.has(value));
      const artistMatches = getComparableArtistCandidates(nextEvent).some((value) =>
        existingArtists.has(value),
      );
      const score = (titleMatches ? 4 : 0) + (artistMatches ? 2 : 0);
      if (score > bestCollisionScore) {
        bestCollisionMatch = existing;
        bestCollisionScore = score;
        bestCollisionScoreCount = 1;
      } else if (score > 0 && score === bestCollisionScore) {
        bestCollisionScoreCount += 1;
      }
    }
    if (bestCollisionScore > 0 && bestCollisionScoreCount === 1) {
      return bestCollisionMatch;
    }
  }
  const sourceOccurrenceMatch = sourceIdentityMatches.find((existing) => {
    const existingNormalizedFields = parseJsonRecord(
      existing.existingEvent.normalizedFieldsJson,
    );
    return (
      !nextHasAmbiguousProvenance &&
      normalizeString(existing.existingEvent.date) === nextEvent.date &&
      (isMultiOccurrenceNormalizedFields(existingNormalizedFields) ||
        isMultiOccurrenceNormalizedFields(nextNormalizedFields)) &&
      hasCompatibleSourceOccurrenceIdentity(
        existing.existingEvent,
        nextEvent,
        nextNormalizedFields,
      )
    );
  });
  if (sourceOccurrenceMatch) {
    return sourceOccurrenceMatch;
  }

  const titleKey = normalizeTitleKey(nextEvent.title);
  const exactMatch = sourceIdentityMatches.find(
    (existing) =>
      normalizeString(existing.existingEvent.date) === nextEvent.date &&
      normalizeTitleKey(existing.existingEvent.title) === titleKey &&
      hasCompatibleSourceOccurrenceIdentity(
        existing.existingEvent,
        nextEvent,
        nextNormalizedFields,
      ),
  );
  if (exactMatch) {
    return exactMatch;
  }

  const sameDateMatch = sourceIdentityMatches.find(
    (existing) =>
      !nextHasAmbiguousProvenance &&
      normalizeString(existing.existingEvent.date) === nextEvent.date &&
      allowsDateOnlySourceIdentityMatch(existing.existingEvent, nextNormalizedFields),
  );
  if (sameDateMatch) {
    return sameDateMatch;
  }

  let bestSemanticMatch: ExistingSourceMatch | null = null;
  let bestSemanticScore = -1;
  let comparableSemanticMatches = 0;

  for (const existing of existingMatches) {
    if (existing.matchedBy !== "same_date_semantic") {
      continue;
    }

    const score = getSemanticDuplicateMatchScore(
      existing.existingEvent,
      nextEvent,
      nextNormalizedFields,
    );
    if (score >= 3) {
      comparableSemanticMatches += 1;
    }
    if (score > bestSemanticScore) {
      bestSemanticScore = score;
      bestSemanticMatch = existing;
    }
  }

  if (bestSemanticScore >= 4) {
    return bestSemanticMatch;
  }

  // Same-date and same-venue collisions are rarely legitimate duplicates here.
  // If there is only one strong candidate for that date/venue, allow an artist-led match.
  if (bestSemanticScore >= 3 && comparableSemanticMatches === 1) {
    return bestSemanticMatch;
  }

  return null;
}

export const findBestExistingMatchForPreparedEventForTesting =
  findBestExistingMatchForPreparedEvent;

export function reconcileAmbiguousOccurrenceKeysWithExistingEvents(
  preparedResults: PrepareEventResult[],
  existingMatches: ExistingSourceMatch[],
): PrepareEventResult[] {
  if (existingMatches.length === 0) {
    return preparedResults;
  }
  const collisionGroups = new Map<string, number[]>();
  preparedResults.forEach((prepared, index) => {
    if (
      prepared.kind !== "ok" ||
      prepared.normalizedFields.sourceOccurrenceAmbiguousProvenance !== true
    ) {
      return;
    }
    const normalizedTime = normalizeEventTime(prepared.event.time);
    const comparableTime =
      normalizedTime.startLabel ??
      extractComparableTimeParts(prepared.event.time)[0] ??
      (normalizeString(prepared.event.time).toLowerCase() ||
        "unknown-time");
    const groupKey = `${prepared.event.date}\u0000${comparableTime}`;
    collisionGroups.set(groupKey, [...(collisionGroups.get(groupKey) ?? []), index]);
  });
  const assignedKeys = new Map<number, string>();
  for (const collisionIndexes of collisionGroups.values()) {
    if (collisionIndexes.length < 2) {
      continue;
    }
    const collisionKeyPool = collisionIndexes
      .map((index) => {
        const prepared = preparedResults[index];
        return prepared?.kind === "ok"
          ? readJsonString(prepared.normalizedFields, "sourceOccurrenceKey")
          : null;
      })
      .filter((key): key is string => key !== null);
    if (
      collisionKeyPool.length !== collisionIndexes.length ||
      new Set(collisionKeyPool).size !== collisionKeyPool.length
    ) {
      continue;
    }
    const groupAssignedKeys = new Map<number, string>();
    const usedExistingIds = new Set<string>();
    const usedKeys = new Set<string>();
    const occupiedExistingKeys = new Set(
      existingMatches
        .map((match) => {
          const existingFields = parseJsonRecord(
            match.existingEvent.normalizedFieldsJson,
          );
          return (
            normalizeString(match.existingEvent.sourceOccurrenceKey) ||
            readJsonString(existingFields, "sourceOccurrenceKey")
          );
        })
        .filter((key): key is string => Boolean(key)),
    );
    for (const index of collisionIndexes) {
      const prepared = preparedResults[index];
      if (!prepared || prepared.kind !== "ok") {
        continue;
      }
      const match = findBestExistingMatchForPreparedEvent(
        existingMatches.filter(
          (candidate) => !usedExistingIds.has(candidate.existingEvent._id),
        ),
        prepared.event,
        prepared.normalizedFields,
      );
      if (!match || match.matchedBy === "same_date_semantic") {
        continue;
      }
      const existingFields = parseJsonRecord(match.existingEvent.normalizedFieldsJson);
      const existingKey =
        normalizeString(match.existingEvent.sourceOccurrenceKey) ||
        readJsonString(existingFields, "sourceOccurrenceKey");
      if (
        existingFields?.sourceOccurrenceAmbiguousProvenance !== true ||
        !existingKey ||
        !collisionKeyPool.includes(existingKey) ||
        usedKeys.has(existingKey)
      ) {
        continue;
      }
      groupAssignedKeys.set(index, existingKey);
      usedExistingIds.add(match.existingEvent._id);
      usedKeys.add(existingKey);
    }
    // A key is free only if no persisted same-source event owns it. Merely not
    // choosing an incompatible existing row during this pass does not make its
    // collision ordinal available for a different semantic child.
    const availableKeys = collisionKeyPool.filter(
      (key) => !usedKeys.has(key) && !occupiedExistingKeys.has(key),
    );
    for (const index of collisionIndexes) {
      if (groupAssignedKeys.has(index)) {
        continue;
      }
      const nextKey = availableKeys.shift();
      if (!nextKey) {
        groupAssignedKeys.clear();
        break;
      }
      groupAssignedKeys.set(index, nextKey);
    }
    if (groupAssignedKeys.size === collisionIndexes.length) {
      for (const [index, key] of groupAssignedKeys) {
        assignedKeys.set(index, key);
      }
    }
  }
  if (assignedKeys.size === 0) {
    return preparedResults;
  }
  const allPersistableKeys = preparedResults
    .map((prepared, index) =>
      prepared.kind === "ok"
        ? assignedKeys.get(index) ??
          readJsonString(prepared.normalizedFields, "sourceOccurrenceKey")
        : null,
    )
    .filter((key): key is string => key !== null)
    .sort();
  if (
    allPersistableKeys.length === 0 ||
    new Set(allPersistableKeys).size !== allPersistableKeys.length
  ) {
    return preparedResults;
  }

  return preparedResults.map((prepared, index) => {
    if (prepared.kind !== "ok") {
      return prepared;
    }
    const sourceOccurrenceKey =
      assignedKeys.get(index) ??
      readJsonString(prepared.normalizedFields, "sourceOccurrenceKey");
    if (!sourceOccurrenceKey) {
      return prepared;
    }
    const normalizedFields = {
      ...prepared.normalizedFields,
      ...(isMultiOccurrenceNormalizedFields(prepared.normalizedFields)
        ? {
            sourceOccurrenceExpectedCount: allPersistableKeys.length,
            sourceOccurrenceExpectedKeys: allPersistableKeys,
          }
        : {}),
      sourceOccurrenceKey,
    };
    return {
      ...prepared,
      normalizedFields,
      event: {
        ...prepared.event,
        sourceOccurrenceKey,
        normalizedFieldsJson: JSON.stringify(normalizedFields),
      },
    };
  });
}

export const reconcileAmbiguousOccurrenceKeysWithExistingEventsForTesting =
  reconcileAmbiguousOccurrenceKeysWithExistingEvents;

export function hasIncompleteAmbiguousCollisionContext(
  existingMatches: ExistingSourceMatch[],
  nextEvent: PreparedEvent,
  nextNormalizedFields: Record<string, unknown>,
): boolean {
  const nextHasAmbiguousProvenance =
    nextNormalizedFields.sourceOccurrenceAmbiguousProvenance === true;
  return existingMatches.some((match) => {
    if (match.matchedBy === "same_date_semantic") {
      return false;
    }
    const existing = match.existingEvent;
    const existingNormalizedFields = parseJsonRecord(existing.normalizedFieldsJson);
    if (!existingNormalizedFields) {
      return false;
    }
    const sharesAmbiguousContext =
      existingNormalizedFields.sourceOccurrenceAmbiguousProvenance === true &&
      normalizeString(existing.date) === normalizeString(nextEvent.date) &&
      areTimesCompatible(existing.time, nextEvent.time);
    if (!sharesAmbiguousContext) {
      return false;
    }
    if (!nextHasAmbiguousProvenance) {
      return true;
    }
    const existingOccurrenceKey =
      normalizeString(existing.sourceOccurrenceKey) ||
      readJsonString(existingNormalizedFields, "sourceOccurrenceKey");
    const nextOccurrenceKey = readJsonString(
      nextNormalizedFields,
      "sourceOccurrenceKey",
    );
    return Boolean(
      existingOccurrenceKey &&
        nextOccurrenceKey &&
        existingOccurrenceKey === nextOccurrenceKey,
    );
  });
}

export const hasIncompleteAmbiguousCollisionContextForTesting =
  hasIncompleteAmbiguousCollisionContext;
