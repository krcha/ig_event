import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader, DatabaseWriter } from "../_generated/server";
import { markSourceOccurrenceTopologyMutation } from "../internal/sourceOccurrenceTopologyEpoch";
import { DomainError } from "../../lib/domain/errors";
import {
  parseStructuredFactsJson,
  projectStructuredFactsToOccurrenceBinding,
} from "../../lib/domain/occurrences/facts";
import { sourceOccurrenceRepresentativeMatchesExpected } from "../../lib/events/source-occurrence-representation";
import {
  buildOccurrenceSignature,
  toOccurrenceCandidateIndexFields,
} from "../../lib/domain/occurrences/signature";
import { isCrossPostCampaignLineageEvent } from "../../lib/events/cross-post-campaign-aggregate-attestation";
import { assertExistingSourceOccurrenceReceiptWithinBounds } from "../internal/sourceOccurrenceReceipts";
import { isSourceOccurrenceBoundedString } from "../internal/sourceOccurrenceLimits";

export const MAX_SOURCE_OCCURRENCES_PER_EVENT_OPERATION = 64;

type ReadContext = { db: DatabaseReader };
type WriteContext = { db: DatabaseWriter };

export type EventOccurrenceTopology = {
  eventId: Id<"events">;
  links: Doc<"instagramEventSources">[];
  occurrences: Doc<"sourceOccurrences">[];
  currentOccurrences: Doc<"sourceOccurrences">[];
  receipts: Doc<"instagramSourceOccurrenceReceipts">[];
};

declare const preparedReconciliationTopologyBrand: unique symbol;

/** Opaque proof consumed by canonical reconciliation without exposing the
 * physical compatibility-link or receipt documents owned by this repository. */
export type PreparedReconciliationEventTopology = Readonly<{
  eventId: Id<"events">;
  [preparedReconciliationTopologyBrand]: true;
}>;

type VenueRebindEvent = Pick<
  Doc<"events">,
  | "_id"
  | "artists"
  | "date"
  | "eventType"
  | "moderationNote"
  | "normalizedVenueIdentity"
  | "normalizedVenueInstagramHandle"
  | "normalizedFieldsJson"
  | "status"
  | "time"
  | "title"
  | "venue"
  | "venueId"
>;

type ExpectedOccurrence = {
  artists: string[];
  date: string;
  key: string;
  time?: string;
  title: string;
  venue: string;
};

function parseExpectedOccurrence(
  occurrence: Doc<"sourceOccurrences">,
): ExpectedOccurrence | null {
  for (const encoded of [occurrence.normalizedOccurrenceJson, occurrence.factsJson]) {
    if (!encoded) continue;
    try {
      const structuredFacts = parseStructuredFactsJson(encoded);
      if (structuredFacts) {
        return {
          ...projectStructuredFactsToOccurrenceBinding(structuredFacts),
          key: occurrence.sourceOccurrenceKey,
        };
      }
      const value = JSON.parse(encoded) as Record<string, unknown>;
      if (
        typeof value.date !== "string" ||
        typeof value.title !== "string" ||
        typeof value.venue !== "string" ||
        !Array.isArray(value.artists) ||
        value.artists.some((artist) => typeof artist !== "string")
      ) {
        continue;
      }
      return {
        artists: value.artists as string[],
        date: value.date,
        key: occurrence.sourceOccurrenceKey,
        ...(typeof value.time === "string" && value.time ? { time: value.time } : {}),
        title: value.title,
        venue: value.venue,
      };
    } catch {
      // Try the immutable facts representation before failing closed.
    }
  }
  return null;
}

async function listForCanonicalEvent(
  ctx: ReadContext,
  eventId: Id<"events">,
): Promise<Doc<"sourceOccurrences">[]> {
  const rows = await ctx.db
    .query("sourceOccurrences")
    .withIndex("by_canonical_event", (q) => q.eq("canonicalEventId", eventId))
    .take(MAX_SOURCE_OCCURRENCES_PER_EVENT_OPERATION + 1);
  if (rows.length > MAX_SOURCE_OCCURRENCES_PER_EVENT_OPERATION) {
    throw new DomainError(
      "OCCURRENCE_INCOMPLETE",
      "Canonical event occurrence set exceeds the safe bounded operation limit.",
    );
  }
  return rows;
}

type SourceOccurrenceCoordinate = {
  sourceIdentity: string;
  sourceOccurrenceKey: string;
};

function sourceOccurrenceCoordinateKey(
  coordinate: SourceOccurrenceCoordinate,
): string {
  return JSON.stringify([
    coordinate.sourceIdentity,
    coordinate.sourceOccurrenceKey,
  ]);
}

function assertBoundedTopologyCoordinate(
  coordinate: SourceOccurrenceCoordinate & { sourceFingerprint: string },
): void {
  if (
    !isSourceOccurrenceBoundedString(coordinate.sourceIdentity) ||
    !isSourceOccurrenceBoundedString(coordinate.sourceOccurrenceKey) ||
    !isSourceOccurrenceBoundedString(coordinate.sourceFingerprint)
  ) {
    throw new DomainError(
      "OCCURRENCE_INCOMPLETE",
      "Canonical event source occurrence topology exceeds its hard string bounds.",
    );
  }
}

function throwTopologyConflict(
  message: string,
  details?: Record<string, unknown>,
): never {
  throw new DomainError(
    "RECONCILIATION_CONFLICT",
    message,
    details ? { details } : undefined,
  );
}

/**
 * Loads the complete bounded compatibility topology for one canonical event.
 *
 * Every current first-class occurrence must have exactly one legacy link and
 * exactly one matching receipt satisfaction. Legacy-only links remain valid
 * during rollout, but a link that names a first-class row must name the exact
 * satisfied row. Callers can retain the returned value as a transaction-local
 * proof that destructive writes were preceded by this fail-closed audit.
 */
async function loadAndAssertEventOccurrenceTopology(
  ctx: ReadContext,
  eventId: Id<"events">,
): Promise<EventOccurrenceTopology> {
  const [links, occurrences] = await Promise.all([
    ctx.db
      .query("instagramEventSources")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .take(MAX_SOURCE_OCCURRENCES_PER_EVENT_OPERATION + 1),
    listForCanonicalEvent(ctx, eventId),
  ]);
  if (links.length > MAX_SOURCE_OCCURRENCES_PER_EVENT_OPERATION) {
    throw new DomainError(
      "OCCURRENCE_INCOMPLETE",
      "Canonical event legacy source set exceeds the safe bounded operation limit.",
    );
  }

  const currentOccurrences = occurrences.filter(
    (occurrence) => occurrence.state !== "superseded",
  );
  const coordinates = new Map<string, SourceOccurrenceCoordinate>();
  const addCoordinate = (
    coordinate: SourceOccurrenceCoordinate & { sourceFingerprint: string },
  ) => {
    assertBoundedTopologyCoordinate(coordinate);
    const key = sourceOccurrenceCoordinateKey(coordinate);
    coordinates.set(key, {
      sourceIdentity: coordinate.sourceIdentity,
      sourceOccurrenceKey: coordinate.sourceOccurrenceKey,
    });
    if (coordinates.size > MAX_SOURCE_OCCURRENCES_PER_EVENT_OPERATION) {
      throw new DomainError(
        "OCCURRENCE_INCOMPLETE",
        "Canonical event source topology exceeds the safe occurrence-key limit.",
      );
    }
  };

  const linkKeys = new Set<string>();
  for (const link of links) {
    addCoordinate(link);
    const key = sourceOccurrenceCoordinateKey(link);
    if (linkKeys.has(key)) {
      throwTopologyConflict(
        "Canonical event has duplicate legacy source-occurrence links.",
        { sourceIdentity: link.sourceIdentity, sourceOccurrenceKey: link.sourceOccurrenceKey },
      );
    }
    linkKeys.add(key);
  }

  const currentOccurrenceKeys = new Set<string>();
  for (const occurrence of currentOccurrences) {
    addCoordinate(occurrence);
    const key = sourceOccurrenceCoordinateKey(occurrence);
    if (currentOccurrenceKeys.has(key) || occurrence.state !== "satisfied") {
      throwTopologyConflict(
        "Canonical event has incompatible current first-class provenance.",
        { sourceOccurrenceId: occurrence._id },
      );
    }
    currentOccurrenceKeys.add(key);
  }

  const sourceIdentities = [
    ...new Set([...coordinates.values()].map((row) => row.sourceIdentity)),
  ];
  const receipts: Doc<"instagramSourceOccurrenceReceipts">[] = [];
  const receiptBySourceIdentity = new Map<
    string,
    Doc<"instagramSourceOccurrenceReceipts">
  >();
  for (const sourceIdentity of sourceIdentities) {
    const receiptRows = await ctx.db
      .query("instagramSourceOccurrenceReceipts")
      .withIndex("by_sourceIdentity", (q) => q.eq("sourceIdentity", sourceIdentity))
      .take(2);
    if (receiptRows.length !== 1) {
      throwTopologyConflict(
        "Canonical event source identity does not have exactly one occurrence receipt.",
        { sourceIdentity },
      );
    }
    const receipt = receiptRows[0]!;
    try {
      assertExistingSourceOccurrenceReceiptWithinBounds(receipt);
    } catch (cause) {
      throw new DomainError(
        "RECONCILIATION_CONFLICT",
        "Canonical event occurrence receipt is invalid or exceeds its hard bounds.",
        { cause, details: { sourceIdentity } },
      );
    }
    if (receipt.sourceIdentity !== sourceIdentity) {
      throwTopologyConflict(
        "Canonical event occurrence receipt has a contradictory source identity.",
        { sourceIdentity },
      );
    }
    receipts.push(receipt);
    receiptBySourceIdentity.set(sourceIdentity, receipt);
    for (const satisfaction of receipt.satisfiedOccurrences) {
      if (satisfaction.eventId !== eventId) continue;
      addCoordinate({
        sourceFingerprint: receipt.sourceFingerprint,
        sourceIdentity,
        sourceOccurrenceKey: satisfaction.key,
      });
    }
  }

  for (const coordinate of coordinates.values()) {
    const coordinateKey = sourceOccurrenceCoordinateKey(coordinate);
    const [exactLinks, exactOccurrences] = await Promise.all([
      ctx.db
        .query("instagramEventSources")
        .withIndex("by_source_occurrence", (q) =>
          q
            .eq("sourceIdentity", coordinate.sourceIdentity)
            .eq("sourceOccurrenceKey", coordinate.sourceOccurrenceKey),
        )
        .take(2),
      ctx.db
        .query("sourceOccurrences")
        .withIndex("by_source_occurrence", (q) =>
          q
            .eq("sourceIdentity", coordinate.sourceIdentity)
            .eq("sourceOccurrenceKey", coordinate.sourceOccurrenceKey),
        )
        .take(2),
    ]);
    const receipt = receiptBySourceIdentity.get(coordinate.sourceIdentity);
    const expectedMatches = (receipt?.expectedOccurrences ?? []).filter(
      (expected) => expected.key === coordinate.sourceOccurrenceKey,
    );
    const expectedKeyCount = receipt?.expectedKeys.filter(
      (key) => key === coordinate.sourceOccurrenceKey,
    ).length ?? 0;
    const satisfiedMatches = receipt?.satisfiedOccurrences.filter(
      (satisfaction) => satisfaction.key === coordinate.sourceOccurrenceKey,
    ) ?? [];
    const satisfiedKeyCount = receipt?.satisfiedKeys.filter(
      (key) => key === coordinate.sourceOccurrenceKey,
    ).length ?? 0;
    const exactLink = exactLinks.length === 1 ? exactLinks[0] : null;
    const exactOccurrence =
      exactOccurrences.length === 1 ? exactOccurrences[0] : null;
    const listedLink = links.find(
      (link) => sourceOccurrenceCoordinateKey(link) === coordinateKey,
    );
    const listedOccurrence = currentOccurrences.find(
      (occurrence) => sourceOccurrenceCoordinateKey(occurrence) === coordinateKey,
    );

    if (
      !receipt ||
      exactLinks.length !== 1 ||
      !exactLink ||
      exactLink.eventId !== eventId ||
      listedLink?._id !== exactLink._id ||
      exactLink.sourceFingerprint !== receipt.sourceFingerprint ||
      expectedMatches.length !== 1 ||
      expectedKeyCount !== 1 ||
      satisfiedMatches.length !== 1 ||
      satisfiedKeyCount !== 1 ||
      satisfiedMatches[0]!.eventId !== eventId ||
      exactOccurrences.length > 1
    ) {
      throwTopologyConflict(
        "Canonical event requires an exact source link and satisfied receipt before provenance mutation.",
        {
          sourceIdentity: coordinate.sourceIdentity,
          sourceOccurrenceKey: coordinate.sourceOccurrenceKey,
        },
      );
    }

    if (exactOccurrence) {
      if (
        exactOccurrence.state !== "satisfied" ||
        exactOccurrence.canonicalEventId !== eventId ||
        exactOccurrence.sourceFingerprint !== receipt.sourceFingerprint ||
        listedOccurrence?._id !== exactOccurrence._id ||
        (exactLink.sourceOccurrenceId !== undefined &&
          exactLink.sourceOccurrenceId !== exactOccurrence._id)
      ) {
        throwTopologyConflict(
          "Canonical event has a source link that disagrees with its first-class occurrence.",
          { sourceOccurrenceId: exactOccurrence._id },
        );
      }
    } else if (listedOccurrence || exactLink.sourceOccurrenceId !== undefined) {
      throwTopologyConflict(
        "Canonical event source link names a missing first-class occurrence.",
        { sourceLinkId: exactLink._id },
      );
    }
  }

  return {
    eventId,
    links,
    occurrences,
    currentOccurrences,
    receipts,
  };
}

async function assertCanReassignEvent(
  ctx: ReadContext,
  fromEventId: Id<"events">,
  targetEvent: Doc<"events">,
): Promise<EventOccurrenceTopology> {
  const topology = await loadAndAssertEventOccurrenceTopology(ctx, fromEventId);
  const receiptBySourceIdentity = new Map(
    topology.receipts.map((receipt) => [receipt.sourceIdentity, receipt]),
  );
  for (const link of topology.links) {
    const receipt = receiptBySourceIdentity.get(link.sourceIdentity);
    const expectedMatches = (receipt?.expectedOccurrences ?? []).filter(
      (expected) => expected.key === link.sourceOccurrenceKey,
    );
    if (
      expectedMatches.length !== 1 ||
      !sourceOccurrenceRepresentativeMatchesExpected(
        targetEvent,
        expectedMatches[0],
      )
    ) {
      throw new DomainError(
        "RECONCILIATION_CONFLICT",
        "Canonical-event merge cannot preserve a legacy source occurrence.",
        { details: { sourceLinkId: link._id } },
      );
    }
  }
  for (const occurrence of topology.currentOccurrences) {
    const expected = parseExpectedOccurrence(occurrence);
    if (
      !expected ||
      !sourceOccurrenceRepresentativeMatchesExpected(targetEvent, expected)
    ) {
      throw new DomainError(
        "RECONCILIATION_CONFLICT",
        "Canonical-event merge cannot preserve a first-class source occurrence.",
        { details: { sourceOccurrenceId: occurrence._id } },
      );
    }
  }
  return topology;
}

async function assertEventCanBeReassigned(
  ctx: ReadContext,
  fromEventId: Id<"events">,
  targetEvent: Doc<"events">,
): Promise<void> {
  await assertCanReassignEvent(ctx, fromEventId, targetEvent);
}

async function prepareReconciliationEventTopology(
  ctx: ReadContext,
  fromEventId: Id<"events">,
  targetEvent: Doc<"events">,
): Promise<PreparedReconciliationEventTopology> {
  return (await assertCanReassignEvent(
    ctx,
    fromEventId,
    targetEvent,
  )) as unknown as PreparedReconciliationEventTopology;
}

async function assertEventMatchesBoundOccurrences(
  ctx: ReadContext,
  eventId: Id<"events">,
  targetEvent: Doc<"events">,
): Promise<void> {
  const occurrences = await listForCanonicalEvent(ctx, eventId);
  for (const occurrence of occurrences) {
    if (occurrence.state === "superseded") continue;
    const expected = parseExpectedOccurrence(occurrence);
    if (
      !expected ||
      !sourceOccurrenceRepresentativeMatchesExpected(targetEvent, expected)
    ) {
      throw new DomainError(
        "RECONCILIATION_CONFLICT",
        "Canonical-event merge cannot preserve a first-class source occurrence.",
        { details: { sourceOccurrenceId: occurrence._id } },
      );
    }
  }
}

async function reassignEvent(
  ctx: WriteContext,
  fromEventId: Id<"events">,
  toEventId: Id<"events">,
  preparedTopology?: EventOccurrenceTopology,
): Promise<number> {
  if (fromEventId === toEventId) return 0;
  if (preparedTopology && preparedTopology.eventId !== fromEventId) {
    throwTopologyConflict("Prepared source topology belongs to another event.");
  }
  const rows = preparedTopology?.occurrences ??
    (await listForCanonicalEvent(ctx, fromEventId));
  for (const occurrence of rows) {
    await ctx.db.patch(occurrence._id, {
      canonicalEventId: toEventId,
      updatedAt: Date.now(),
    });
  }
  return rows.length;
}

async function reassignPreparedReconciliationEventTopology(
  ctx: WriteContext,
  preparedTopology: PreparedReconciliationEventTopology,
  toEventId: Id<"events">,
  options: { topologyEpochVerified: boolean },
): Promise<number> {
  return reassignPreparedEventTopology(
    ctx,
    preparedTopology as unknown as EventOccurrenceTopology,
    toEventId,
    options,
  );
}

async function assertReconciliationEventTopology(
  ctx: ReadContext,
  eventId: Id<"events">,
): Promise<void> {
  await loadAndAssertEventOccurrenceTopology(ctx, eventId);
}

async function supersedeAndDetachEvent(
  ctx: WriteContext,
  eventId: Id<"events">,
  options: {
    preparedTopology?: EventOccurrenceTopology;
    topologyEpochVerified: boolean;
  },
): Promise<number> {
  if (typeof options?.topologyEpochVerified !== "boolean") {
    throw new Error("Topology detachment requires an explicit epoch classification.");
  }
  const { preparedTopology, topologyEpochVerified } = options;
  if (preparedTopology && preparedTopology.eventId !== eventId) {
    throwTopologyConflict("Prepared source topology belongs to another event.");
  }
  const rows = preparedTopology?.occurrences ??
    (await listForCanonicalEvent(ctx, eventId));
  for (const occurrence of rows) {
    await ctx.db.patch(occurrence._id, {
      canonicalEventId: undefined,
      state: "superseded",
      updatedAt: Date.now(),
    });
  }
  if (rows.length > 0) {
    await markSourceOccurrenceTopologyMutation(ctx, { verified: topologyEpochVerified });
  }
  return rows.length;
}

async function removeLegacyBindingsForDeletedEvent(
  ctx: WriteContext,
  eventId: Id<"events">,
  options: {
    preparedTopology?: EventOccurrenceTopology;
    topologyEpochVerified: boolean;
  },
): Promise<{
  linkCount: number;
  remainingRepresentativeEventIds: Id<"events">[];
  retiredOccurrenceKeys: string[];
}> {
  if (typeof options?.topologyEpochVerified !== "boolean") {
    throw new Error("Legacy topology deletion requires an explicit epoch classification.");
  }
  const { preparedTopology, topologyEpochVerified } = options;
  if (preparedTopology && preparedTopology.eventId !== eventId) {
    throwTopologyConflict("Prepared source topology belongs to another event.");
  }
  const topology = preparedTopology ??
    (await loadAndAssertEventOccurrenceTopology(ctx, eventId));
  const links = topology.links;

  const now = Date.now();
  const remainingRepresentativeEventIds = new Set<Id<"events">>();
  const retiredOccurrenceKeys = new Set<string>();
  const receiptPatches: Array<{
    id: Id<"instagramSourceOccurrenceReceipts">;
    patch: Partial<Doc<"instagramSourceOccurrenceReceipts">>;
  }> = [];
  for (const receipt of topology.receipts) {
    const removedSatisfactions = receipt.satisfiedOccurrences.filter(
      (occurrence) => occurrence.eventId === eventId,
    );
    const satisfiedOccurrences = receipt.satisfiedOccurrences.filter(
      (occurrence) => occurrence.eventId !== eventId,
    );
    if (satisfiedOccurrences.length === receipt.satisfiedOccurrences.length) continue;
    for (const occurrence of removedSatisfactions) {
      retiredOccurrenceKeys.add(occurrence.key);
    }
    for (const occurrence of satisfiedOccurrences) {
      remainingRepresentativeEventIds.add(occurrence.eventId);
    }
    const removedKeys = new Set(removedSatisfactions.map((occurrence) => occurrence.key));
    const remainingSatisfiedKeys = new Set(
      satisfiedOccurrences.map((occurrence) => occurrence.key),
    );
    receiptPatches.push({
      id: receipt._id,
      patch: {
        deferredChildCount: receipt.deferredChildKeys.filter(
          (key) => !removedKeys.has(key),
        ).length,
        deferredChildKeys: receipt.deferredChildKeys.filter(
          (key) => !removedKeys.has(key),
        ),
        expectedKeys: receipt.expectedKeys.filter(
          (key) => !removedKeys.has(key),
        ),
        expectedOccurrences: receipt.expectedOccurrences?.filter(
          (occurrence) => !removedKeys.has(occurrence.key),
        ),
        satisfiedKeys: receipt.satisfiedKeys.filter((key) =>
          remainingSatisfiedKeys.has(key),
        ),
        satisfiedOccurrences,
        updatedAt: now,
      },
    });
  }
  if (
    remainingRepresentativeEventIds.size >
    MAX_SOURCE_OCCURRENCES_PER_EVENT_OPERATION
  ) {
    throw new DomainError(
      "OCCURRENCE_INCOMPLETE",
      "Canonical event deletion exceeds the safe representative refresh limit.",
    );
  }
  for (const update of receiptPatches) {
    await ctx.db.patch(update.id, update.patch);
  }
  for (const link of links) await ctx.db.delete(link._id);
  if (receiptPatches.length > 0 || links.length > 0) {
    await markSourceOccurrenceTopologyMutation(ctx, { verified: topologyEpochVerified });
  }
  return {
    linkCount: links.length,
    remainingRepresentativeEventIds: [...remainingRepresentativeEventIds],
    retiredOccurrenceKeys: [...retiredOccurrenceKeys].sort(),
  };
}

/**
 * Applies a previously validated event topology after any dedicated receipt
 * re-attestation in the same mutation. Receipt rows may already name the
 * target, but may never point at a third event or lose a prepared source key.
 */
async function reassignPreparedEventTopology(
  ctx: WriteContext,
  preparedTopology: EventOccurrenceTopology,
  toEventId: Id<"events">,
  options: {
    preserveLegacyLinks?: boolean;
    topologyEpochVerified: boolean;
  },
): Promise<number> {
  const fromEventId = preparedTopology.eventId;
  if (typeof options?.topologyEpochVerified !== "boolean") {
    throw new Error("Topology reassignment requires an explicit epoch classification.");
  }
  if (fromEventId === toEventId) return 0;

  const currentReceipts = new Map<
    string,
    Doc<"instagramSourceOccurrenceReceipts">
  >();
  const receiptPatches: Array<{
    id: Id<"instagramSourceOccurrenceReceipts">;
    satisfiedOccurrences: Doc<"instagramSourceOccurrenceReceipts">["satisfiedOccurrences"];
    updatedAt: number;
  }> = [];
  for (const preparedReceipt of preparedTopology.receipts) {
    const rows = await ctx.db
      .query("instagramSourceOccurrenceReceipts")
      .withIndex("by_sourceIdentity", (q) =>
        q.eq("sourceIdentity", preparedReceipt.sourceIdentity),
      )
      .take(2);
    if (rows.length !== 1 || rows[0]!._id !== preparedReceipt._id) {
      throwTopologyConflict(
        "Prepared source receipt changed before canonical-event reassignment.",
        { sourceIdentity: preparedReceipt.sourceIdentity },
      );
    }
    const receipt = rows[0]!;
    try {
      assertExistingSourceOccurrenceReceiptWithinBounds(receipt);
    } catch (cause) {
      throw new DomainError(
        "RECONCILIATION_CONFLICT",
        "Prepared source receipt became invalid before canonical-event reassignment.",
        { cause, details: { sourceIdentity: receipt.sourceIdentity } },
      );
    }
    currentReceipts.set(receipt.sourceIdentity, receipt);
  }

  for (const link of preparedTopology.links) {
    const currentLink = await ctx.db.get(link._id);
    const receipt = currentReceipts.get(link.sourceIdentity);
    const satisfactions = receipt?.satisfiedOccurrences.filter(
      (item) => item.key === link.sourceOccurrenceKey,
    ) ?? [];
    if (
      !currentLink ||
      currentLink.eventId !== fromEventId ||
      currentLink.sourceIdentity !== link.sourceIdentity ||
      currentLink.sourceOccurrenceKey !== link.sourceOccurrenceKey ||
      currentLink.sourceFingerprint !== link.sourceFingerprint ||
      !receipt ||
      receipt.sourceFingerprint !== link.sourceFingerprint ||
      satisfactions.length !== 1 ||
      (satisfactions[0]!.eventId !== fromEventId &&
        satisfactions[0]!.eventId !== toEventId)
    ) {
      throwTopologyConflict(
        "Prepared source topology changed before canonical-event reassignment.",
        { sourceLinkId: link._id },
      );
    }
  }

  for (const receipt of currentReceipts.values()) {
    const preparedKeys = new Set(
      preparedTopology.links
        .filter((link) => link.sourceIdentity === receipt.sourceIdentity)
        .map((link) => link.sourceOccurrenceKey),
    );
    if (
      receipt.satisfiedOccurrences.some(
        (item) => item.eventId === fromEventId && !preparedKeys.has(item.key),
      )
    ) {
      throwTopologyConflict(
        "Canonical-event reassignment found an unlinked receipt satisfaction.",
        { sourceIdentity: receipt.sourceIdentity },
      );
    }
    const satisfiedOccurrences = receipt.satisfiedOccurrences.map((item) =>
      item.eventId === fromEventId ? { ...item, eventId: toEventId } : item,
    );
    const changed = satisfiedOccurrences.some(
      (item, index) =>
        item.eventId !== receipt.satisfiedOccurrences[index]!.eventId,
    );
    if (!changed) continue;
    if (
      new Set(satisfiedOccurrences.map((item) => item.eventId)).size !==
      satisfiedOccurrences.length
    ) {
      throwTopologyConflict(
        "Canonical-event reassignment would collapse distinct source occurrences.",
        { sourceIdentity: receipt.sourceIdentity },
      );
    }
    receiptPatches.push({
      id: receipt._id,
      satisfiedOccurrences,
      updatedAt: Math.max(Date.now(), receipt.updatedAt + 1),
    });
  }

  for (const update of receiptPatches) {
    await ctx.db.patch(update.id, {
      satisfiedOccurrences: update.satisfiedOccurrences,
      updatedAt: update.updatedAt,
    });
  }
  if (!options.preserveLegacyLinks) {
    for (const link of preparedTopology.links) {
      await ctx.db.patch(link._id, {
        eventId: toEventId,
        updatedAt: Math.max(Date.now(), link.updatedAt + 1),
      });
    }
  }
  const occurrenceCount = await reassignEvent(
    ctx,
    fromEventId,
    toEventId,
    preparedTopology,
  );
  if (
    receiptPatches.length > 0 ||
    (!options.preserveLegacyLinks && preparedTopology.links.length > 0) ||
    occurrenceCount > 0
  ) {
    await markSourceOccurrenceTopologyMutation(ctx, {
      verified: options.topologyEpochVerified,
    });
  }
  return occurrenceCount;
}

async function updateSatisfiedOccurrenceFromExpected(
  ctx: WriteContext,
  options: {
    expected: {
      artists: string[];
      date: string;
      key: string;
      time?: string;
      title: string;
      venue: string;
    };
    representative: VenueRebindEvent;
    sourceFingerprint?: string;
    sourceLink: Doc<"instagramEventSources">;
    topologyEpochVerified: boolean;
  },
): Promise<boolean> {
  if (typeof options.topologyEpochVerified !== "boolean") {
    throw new Error("Occurrence update requires an explicit topology epoch classification.");
  }
  const occurrence = options.sourceLink.sourceOccurrenceId
    ? await ctx.db.get(options.sourceLink.sourceOccurrenceId)
    : await ctx.db
        .query("sourceOccurrences")
        .withIndex("by_source_occurrence", (q) =>
          q
            .eq("sourceIdentity", options.sourceLink.sourceIdentity)
            .eq("sourceOccurrenceKey", options.sourceLink.sourceOccurrenceKey),
        )
        .unique();
  if (!occurrence) return false;
  if (
    occurrence.sourceIdentity !== options.sourceLink.sourceIdentity ||
    occurrence.sourceOccurrenceKey !== options.expected.key ||
    occurrence.canonicalEventId !== options.representative._id ||
    occurrence.state === "superseded"
  ) {
    throw new DomainError(
      "RECONCILIATION_CONFLICT",
      "Corrected legacy receipt does not match its first-class source occurrence.",
      { details: { sourceOccurrenceId: occurrence._id } },
    );
  }
  const normalizedOccurrence = {
    artists: options.expected.artists,
    date: options.expected.date,
    eventType: options.representative.eventType,
    time: options.expected.time ?? null,
    title: options.expected.title,
    venue: options.expected.venue,
    venueId: options.representative.venueId ?? null,
  };
  const signature = toOccurrenceCandidateIndexFields(
    buildOccurrenceSignature({
      artists: options.expected.artists,
      eventType: options.representative.eventType,
      localDate: options.expected.date,
      normalizedVenueIdentity:
        options.representative.normalizedVenueIdentity ?? options.expected.venue,
      time: options.expected.time,
      title: options.expected.title,
      venueId: options.representative.venueId,
      venueInstagramHandle: options.representative.normalizedVenueInstagramHandle,
    }),
  );
  await ctx.db.patch(occurrence._id, {
    canonicalEventId: options.representative._id,
    normalizedOccurrenceJson: JSON.stringify(normalizedOccurrence),
    ...signature,
    ...(options.sourceFingerprint
      ? { sourceFingerprint: options.sourceFingerprint }
      : {}),
    state: "satisfied",
    updatedAt: Date.now(),
    venueId: options.representative.venueId,
    venueResolutionStatus: options.representative.venueId
      ? "resolved"
      : "unresolved",
  });
  await markSourceOccurrenceTopologyMutation(ctx, {
    verified: options.topologyEpochVerified,
  });
  return true;
}

function occurrenceVenueIdentityChanged(
  currentEvent: VenueRebindEvent,
  nextEvent: VenueRebindEvent,
): boolean {
  return [
    "venue",
    "venueId",
    "normalizedVenueIdentity",
    "normalizedVenueInstagramHandle",
  ].some(
    (field) =>
      currentEvent[field as keyof VenueRebindEvent] !==
      nextEvent[field as keyof VenueRebindEvent],
  );
}

/**
 * Re-attests a human-authorized venue canonicalization across the compatibility
 * receipt and the first-class occurrence in one bounded transaction.
 *
 * A venue write with no provenance remains a plain moderation edit. Once an
 * event has either legacy or first-class provenance, however, the complete
 * legacy link/receipt topology must be coherent and every current first-class
 * occurrence must be reachable from one of those exact links. This prevents a
 * moderation write from silently changing public identity while leaving the
 * duplicate/reconciliation identity stale.
 */
async function rebindCanonicalVenue(
  ctx: WriteContext,
  currentEvent: VenueRebindEvent,
  nextEvent: VenueRebindEvent,
  options: { dryRun?: boolean; topologyEpochVerified: boolean },
): Promise<Id<"events">[]> {
  if (typeof options?.topologyEpochVerified !== "boolean") {
    throw new Error("Venue rebinding requires an explicit topology epoch classification.");
  }
  if (!occurrenceVenueIdentityChanged(currentEvent, nextEvent)) {
    return [currentEvent._id];
  }
  if (isCrossPostCampaignLineageEvent(currentEvent)) {
    throw new DomainError(
      "RECONCILIATION_CONFLICT",
      "Audited campaign lineage requires its dedicated atomic re-attestation before venue rebinding.",
    );
  }

  const [links, boundOccurrences] = await Promise.all([
    ctx.db
      .query("instagramEventSources")
      .withIndex("by_event", (q) => q.eq("eventId", currentEvent._id))
      .take(MAX_SOURCE_OCCURRENCES_PER_EVENT_OPERATION + 1),
    listForCanonicalEvent(ctx, currentEvent._id),
  ]);
  if (links.length > MAX_SOURCE_OCCURRENCES_PER_EVENT_OPERATION) {
    throw new DomainError(
      "OCCURRENCE_INCOMPLETE",
      "Human venue canonicalization exceeds the safe provenance-link limit.",
    );
  }
  const currentBoundOccurrences = boundOccurrences.filter(
    (occurrence) => occurrence.state !== "superseded",
  );
  if (links.length === 0) {
    if (currentBoundOccurrences.length > 0) {
      throw new DomainError(
        "RECONCILIATION_CONFLICT",
        "Human venue canonicalization found first-class provenance without its compatibility link.",
      );
    }
    return [currentEvent._id];
  }

  type ReceiptUpdate = {
    receipt: Doc<"instagramSourceOccurrenceReceipts">;
    expectedByKey: Map<string, ExpectedOccurrence>;
  };
  const receiptUpdates = new Map<
    Id<"instagramSourceOccurrenceReceipts">,
    ReceiptUpdate
  >();
  const linkedOccurrenceIds = new Set<Id<"sourceOccurrences">>();
  const receiptIdBySourceIdentity = new Map<
    string,
    Id<"instagramSourceOccurrenceReceipts">
  >();
  const affectedRepresentativeEventIds = new Set<Id<"events">>([
    currentEvent._id,
  ]);

  for (const link of links) {
    const receiptRows = await ctx.db
      .query("instagramSourceOccurrenceReceipts")
      .withIndex("by_sourceIdentity", (q) =>
        q.eq("sourceIdentity", link.sourceIdentity),
      )
      .take(2);
    const receipt = receiptRows.length === 1 ? receiptRows[0] : null;
    if (receipt) assertExistingSourceOccurrenceReceiptWithinBounds(receipt);
    const expectedMatches = (receipt?.expectedOccurrences ?? []).filter(
      (occurrence) => occurrence.key === link.sourceOccurrenceKey,
    );
    const satisfiedMatches = (receipt?.satisfiedOccurrences ?? []).filter(
      (occurrence) => occurrence.key === link.sourceOccurrenceKey,
    );
    const expected = expectedMatches[0];
    if (
      !receipt ||
      receipt.sourceFingerprint !== link.sourceFingerprint ||
      expectedMatches.length !== 1 ||
      satisfiedMatches.length !== 1 ||
      satisfiedMatches[0].eventId !== currentEvent._id ||
      receipt.expectedKeys.filter((key) => key === link.sourceOccurrenceKey)
        .length !== 1 ||
      receipt.satisfiedKeys.filter((key) => key === link.sourceOccurrenceKey)
        .length !== 1 ||
      !sourceOccurrenceRepresentativeMatchesExpected(currentEvent, expected)
    ) {
      throw new DomainError(
        "RECONCILIATION_CONFLICT",
        "Human venue canonicalization requires an exact source link and satisfied receipt.",
        { details: { sourceLinkId: link._id } },
      );
    }

    const nextExpected = { ...expected, venue: nextEvent.venue };
    if (!sourceOccurrenceRepresentativeMatchesExpected(nextEvent, nextExpected)) {
      throw new DomainError(
        "RECONCILIATION_CONFLICT",
        "Canonicalized event would not represent its re-attested source occurrence.",
        { details: { sourceLinkId: link._id } },
      );
    }

    const occurrence = link.sourceOccurrenceId
      ? await ctx.db.get(link.sourceOccurrenceId)
      : await ctx.db
          .query("sourceOccurrences")
          .withIndex("by_source_occurrence", (q) =>
            q
              .eq("sourceIdentity", link.sourceIdentity)
              .eq("sourceOccurrenceKey", link.sourceOccurrenceKey),
          )
          .unique();
    if (link.sourceOccurrenceId && !occurrence) {
      throw new DomainError(
        "RECONCILIATION_CONFLICT",
        "Human venue canonicalization found a dangling source-occurrence link.",
        { details: { sourceLinkId: link._id } },
      );
    }
    if (occurrence) {
      if (
        occurrence.sourceIdentity !== link.sourceIdentity ||
        occurrence.sourceOccurrenceKey !== link.sourceOccurrenceKey ||
        occurrence.canonicalEventId !== currentEvent._id ||
        occurrence.state !== "satisfied"
      ) {
        throw new DomainError(
          "RECONCILIATION_CONFLICT",
          "Human venue canonicalization found incompatible first-class provenance.",
          { details: { sourceOccurrenceId: occurrence._id } },
        );
      }
      linkedOccurrenceIds.add(occurrence._id);
    }

    const receiptUpdate = receiptUpdates.get(receipt._id) ?? {
      receipt,
      expectedByKey: new Map(),
    };
    receiptUpdate.expectedByKey.set(link.sourceOccurrenceKey, nextExpected);
    receiptUpdates.set(receipt._id, receiptUpdate);
    receiptIdBySourceIdentity.set(link.sourceIdentity, receipt._id);
    for (const satisfaction of receipt.satisfiedOccurrences) {
      affectedRepresentativeEventIds.add(satisfaction.eventId);
    }
  }

  if (
    currentBoundOccurrences.some(
      (occurrence) => !linkedOccurrenceIds.has(occurrence._id),
    )
  ) {
    throw new DomainError(
      "RECONCILIATION_CONFLICT",
      "Human venue canonicalization found an unlinked first-class occurrence.",
    );
  }
  if (
    affectedRepresentativeEventIds.size >
    MAX_SOURCE_OCCURRENCES_PER_EVENT_OPERATION
  ) {
    throw new DomainError(
      "OCCURRENCE_INCOMPLETE",
      "Human venue canonicalization exceeds the safe representative refresh limit.",
    );
  }

  if (!options.dryRun) {
    const now = Date.now();
    for (const { receipt, expectedByKey } of receiptUpdates.values()) {
      await ctx.db.patch(receipt._id, {
        expectedOccurrences: (receipt.expectedOccurrences ?? []).map(
          (occurrence) => expectedByKey.get(occurrence.key) ?? occurrence,
        ),
        updatedAt: now,
      });
    }
    for (const link of links) {
      const receiptId = receiptIdBySourceIdentity.get(link.sourceIdentity);
      const update = receiptId ? receiptUpdates.get(receiptId) : undefined;
      const nextExpected = update?.expectedByKey.get(link.sourceOccurrenceKey);
      if (!nextExpected) {
        throw new DomainError(
          "RECONCILIATION_CONFLICT",
          "Human venue canonicalization lost its prepared receipt update.",
        );
      }
      await updateSatisfiedOccurrenceFromExpected(ctx, {
        expected: nextExpected,
        representative: nextEvent,
        sourceFingerprint: link.sourceFingerprint,
        sourceLink: link,
        topologyEpochVerified: options.topologyEpochVerified,
      });
    }
    if (receiptUpdates.size > 0) {
      await markSourceOccurrenceTopologyMutation(ctx, {
        verified: options.topologyEpochVerified,
      });
    }
  }
  return [...affectedRepresentativeEventIds];
}

export const sourceOccurrenceProvenanceRepository = {
  assertCanReassignEvent,
  assertEventCanBeReassigned,
  assertEventMatchesBoundOccurrences,
  assertReconciliationEventTopology,
  listForCanonicalEvent,
  loadAndAssertEventOccurrenceTopology,
  prepareReconciliationEventTopology,
  reassignPreparedEventTopology,
  reassignPreparedReconciliationEventTopology,
  removeLegacyBindingsForDeletedEvent,
  rebindCanonicalVenue,
  supersedeAndDetachEvent,
  updateSatisfiedOccurrenceFromExpected,
};
