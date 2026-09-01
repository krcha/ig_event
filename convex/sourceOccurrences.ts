import {
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server";
import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { query } from "./_generated/server";
import { requireAdminOrServiceSecret } from "./authz";
import { DomainError } from "../lib/domain/errors";
import {
  parseStructuredFactsJson,
  projectStructuredFactsToOccurrenceBinding,
} from "../lib/domain/occurrences/facts";
import { parseCanonicalEventPayload } from "../lib/domain/occurrences/canonical-event-payload";
import {
  buildOccurrenceSignature,
  toOccurrenceCandidateIndexFields,
  type OccurrenceCandidateIndexFields,
} from "../lib/domain/occurrences/signature";
import { canonicalizeSourceUrl } from "../lib/domain/source-url";
import { loadOccurrenceCandidates } from "./repositories/occurrenceCandidates";
import {
  resolveVenueClaimsForWrite,
  resolveVenueForWrite,
  type ConvexVenueResolution,
} from "./venueResolver";
import { assertSourceOccurrenceSyncPlanWithinBounds } from "./internal/sourceOccurrenceLimits";
import { markSourceOccurrenceTopologyMutation } from "./internal/sourceOccurrenceTopologyEpoch";

const venueResolutionStatusValidator = v.union(
  v.literal("resolved"),
  v.literal("ambiguous"),
  v.literal("unresolved"),
);
const sourceOccurrenceStateValidator = v.union(
  v.literal("expected"),
  v.literal("deferred"),
  v.literal("satisfied"),
  v.literal("superseded"),
);
const sourceOccurrenceDocumentValidator = v.object({
  _creationTime: v.number(),
  _id: v.id("sourceOccurrences"),
  canonicalEventId: v.optional(v.id("events")),
  canonicalEventJson: v.optional(v.string()),
  canonicalSourceUrl: v.string(),
  createdAt: v.number(),
  factsJson: v.string(),
  normalizedOccurrenceJson: v.optional(v.string()),
  occurrenceArtistFingerprint: v.string(),
  occurrenceDateKey: v.string(),
  occurrenceEventType: v.string(),
  occurrenceOrdinal: v.number(),
  occurrenceSignatureHash: v.string(),
  occurrenceSignatureVersion: v.number(),
  occurrenceTimeIdentity: v.string(),
  occurrenceTitleFamily: v.string(),
  occurrenceVenueIdentity: v.string(),
  provider: v.literal("instagram"),
  sourceDocumentId: v.id("scrapedPosts"),
  sourceFingerprint: v.string(),
  sourceIdentity: v.string(),
  sourceOccurrenceKey: v.string(),
  sourceRevision: v.number(),
  state: sourceOccurrenceStateValidator,
  updatedAt: v.number(),
  venueId: v.optional(v.id("venues")),
  venueResolutionStatus: venueResolutionStatusValidator,
});
const canonicalEventCandidatesResultValidator = v.object({
  candidates: v.array(v.any()),
  complete: v.boolean(),
  limit: v.number(),
});
const normalizedOccurrenceCandidatesResultValidator = v.object({
  candidates: v.array(v.any()),
  complete: v.boolean(),
  limit: v.number(),
  venueResolutionStatus: venueResolutionStatusValidator,
});

export type SourceOccurrencePlanRecord = {
  confirmedPastKeys?: string[];
  deferredChildKeys: string[];
  expectedKeys: string[];
  expectedOccurrences: Array<{
    artists: string[];
    canonicalEventJson?: string;
    date: string;
    key: string;
    time?: string;
    title: string;
    venue: string;
    factsJson?: string;
  }>;
  sourceFingerprint: string;
  sourceIdentity: string;
};

type SourceOccurrenceRepresentative = Pick<
  Doc<"events">,
  | "_id"
  | "artists"
  | "date"
  | "eventType"
  | "normalizedVenueIdentity"
  | "normalizedVenueInstagramHandle"
  | "time"
  | "title"
  | "venue"
  | "venueId"
>;

export type SyncedSourceOccurrence = {
  canonicalSourceUrl: string;
  sourceOccurrenceId: Id<"sourceOccurrences">;
};

export function buildEventOccurrenceIndexPatch(
  event: Pick<
    Doc<"events">,
    | "artists"
    | "date"
    | "eventType"
    | "normalizedVenueIdentity"
    | "normalizedVenueInstagramHandle"
    | "time"
    | "title"
    | "venue"
    | "venueId"
  >,
): OccurrenceCandidateIndexFields {
  return toOccurrenceCandidateIndexFields(
    buildOccurrenceSignature({
      artists: event.artists,
      eventType: event.eventType,
      localDate: event.date,
      normalizedVenueIdentity: event.normalizedVenueIdentity ?? event.venue,
      time: event.time,
      title: event.title,
      venueId: event.venueId,
      venueInstagramHandle: event.normalizedVenueInstagramHandle,
    }),
  );
}

function buildOccurrenceRow(options: {
  canonicalEvent?: SourceOccurrenceRepresentative;
  canonicalSourceUrl: string;
  expected?: SourceOccurrencePlanRecord["expectedOccurrences"][number];
  occurrenceOrdinal: number;
  plan: SourceOccurrencePlanRecord;
  sourceDocument: Doc<"scrapedPosts">;
  sourceOccurrenceKey: string;
  state: "expected" | "deferred" | "satisfied";
  venueResolution?: ConvexVenueResolution;
}) {
  const expected = options.expected;
  const representative = options.canonicalEvent;
  const structuredFacts = expected?.factsJson
    ? parseStructuredFactsJson(expected.factsJson)
    : null;
  const canonicalEventPayload = expected?.canonicalEventJson
    ? parseCanonicalEventPayload(expected.canonicalEventJson)
    : null;
  if (expected?.canonicalEventJson && !canonicalEventPayload) {
    throw new DomainError(
      "OCCURRENCE_INCOMPLETE",
      "Expected occurrence has an invalid canonical-event payload.",
    );
  }
  const factBinding = structuredFacts
    ? projectStructuredFactsToOccurrenceBinding(structuredFacts)
    : null;
  const resolvedVenueId = options.venueResolution?.venueFields.venueId;
  const normalizedVenue =
    options.venueResolution?.canonicalVenueName ?? expected?.venue ?? "";
  const eventForSignature = factBinding
    ? {
        artists: factBinding.artists,
        date: factBinding.date,
        eventType:
          structuredFacts?.eventTypeClaim?.trim() || "event",
        normalizedVenueIdentity:
          options.venueResolution?.venueFields.normalizedVenueIdentity ??
          factBinding.venue,
        normalizedVenueInstagramHandle:
          structuredFacts?.venueHandleClaim ??
          options.venueResolution?.venueFields.normalizedVenueInstagramHandle,
        time: factBinding.time,
        title: factBinding.title,
        venue: factBinding.venue,
        venueId: representative?.venueId ?? resolvedVenueId,
      }
    : {
        artists: representative?.artists ?? expected?.artists ?? [],
        date: representative?.date ?? expected?.date ?? "unknown-date",
        eventType: representative?.eventType ?? "event",
        normalizedVenueIdentity:
          representative?.normalizedVenueIdentity ??
          options.venueResolution?.venueFields.normalizedVenueIdentity ??
          representative?.venue ??
          normalizedVenue,
        normalizedVenueInstagramHandle:
          representative?.normalizedVenueInstagramHandle ??
          options.venueResolution?.venueFields.normalizedVenueInstagramHandle,
        time: representative?.time ?? expected?.time,
        title: representative?.title ?? expected?.title ?? "Unknown occurrence",
        venue: representative?.venue ?? normalizedVenue,
        venueId: representative?.venueId ?? resolvedVenueId,
      };
  const signatureFields = buildEventOccurrenceIndexPatch(eventForSignature);
  return {
    provider: "instagram" as const,
    sourceDocumentId: options.sourceDocument._id,
    sourceIdentity: options.plan.sourceIdentity,
    canonicalSourceUrl: options.canonicalSourceUrl,
    sourceFingerprint: options.plan.sourceFingerprint,
    sourceRevision: options.sourceDocument.sourceRevision ?? 1,
    sourceOccurrenceKey: options.sourceOccurrenceKey,
    occurrenceOrdinal: options.occurrenceOrdinal,
    factsJson:
      expected?.factsJson ??
      JSON.stringify(
        expected ?? {
          key: options.sourceOccurrenceKey,
          deferred: true,
        },
      ),
    ...(expected?.canonicalEventJson
      ? { canonicalEventJson: expected.canonicalEventJson }
      : {}),
    normalizedOccurrenceJson: JSON.stringify({
      artists: eventForSignature.artists,
      date: eventForSignature.date,
      ...(canonicalEventPayload?.description
        ? { description: canonicalEventPayload.description }
        : {}),
      eventType: eventForSignature.eventType,
      time: eventForSignature.time ?? null,
      title: eventForSignature.title,
      venue: eventForSignature.venue,
      venueId: eventForSignature.venueId ?? null,
    }),
    venueResolutionStatus: representative
      ? representative.venueId
        ? ("resolved" as const)
        : ("unresolved" as const)
      : options.venueResolution?.resolution.status ?? ("unresolved" as const),
    ...(eventForSignature.venueId
      ? { venueId: eventForSignature.venueId }
      : {}),
    ...(representative ? { canonicalEventId: representative._id } : {}),
    state: options.state,
    ...signatureFields,
  };
}

/** Deterministic row shape used by migration readiness verification. */
export function buildSatisfiedSourceOccurrenceRow(options: {
  canonicalSourceUrl: string;
  plan: SourceOccurrencePlanRecord;
  representativeEvent: SourceOccurrenceRepresentative;
  sourceDocument: Doc<"scrapedPosts">;
  sourceOccurrenceKey: string;
}) {
  const occurrenceOrdinal = options.plan.expectedOccurrences.findIndex(
    (expected) => expected.key === options.sourceOccurrenceKey,
  );
  const expected = options.plan.expectedOccurrences[occurrenceOrdinal];
  if (occurrenceOrdinal < 0 || !expected) {
    throw new DomainError(
      "OCCURRENCE_INCOMPLETE",
      "Satisfied occurrence key is absent from the expected source plan.",
    );
  }
  return buildOccurrenceRow({
    canonicalEvent: options.representativeEvent,
    canonicalSourceUrl: options.canonicalSourceUrl,
    expected,
    occurrenceOrdinal,
    plan: options.plan,
    sourceDocument: options.sourceDocument,
    sourceOccurrenceKey: options.sourceOccurrenceKey,
    state: "satisfied",
  });
}

async function upsertSourceOccurrenceRow(
  ctx: MutationCtx,
  row: ReturnType<typeof buildOccurrenceRow>,
): Promise<Id<"sourceOccurrences">> {
  const existing = await ctx.db
    .query("sourceOccurrences")
    .withIndex("by_source_occurrence", (q) =>
      q
        .eq("sourceIdentity", row.sourceIdentity)
        .eq("sourceOccurrenceKey", row.sourceOccurrenceKey),
    )
    .unique();
  const now = Date.now();
  if (!existing) {
    return ctx.db.insert("sourceOccurrences", {
      ...row,
      createdAt: now,
      updatedAt: now,
    });
  }
  if (
    existing.sourceDocumentId !== row.sourceDocumentId ||
    existing.sourceRevision > row.sourceRevision ||
    (existing.canonicalEventId &&
      row.canonicalEventId &&
      existing.canonicalEventId !== row.canonicalEventId)
  ) {
    throw new DomainError(
      "SOURCE_REVISION_CHANGED",
      "Source occurrence identity is bound to incompatible current state.",
      {
        details: {
          existingSourceDocumentId: existing.sourceDocumentId,
          existingSourceRevision: existing.sourceRevision,
          sourceDocumentId: row.sourceDocumentId,
          sourceOccurrenceKey: row.sourceOccurrenceKey,
          sourceRevision: row.sourceRevision,
        },
      },
    );
  }
  if (existing.state === "superseded") {
    throw new DomainError(
      "RECONCILIATION_CONFLICT",
      "A superseded source occurrence cannot be silently reactivated.",
      { details: { sourceOccurrenceKey: row.sourceOccurrenceKey } },
    );
  }
  // A later child write has no representative for an already-satisfied
  // sibling. Preserve that sibling's complete canonical/signature/venue row;
  // retaining only its state while overwriting identity fields from a fresh
  // resolver lookup would split it from its canonical event.
  if (existing.state === "satisfied" && row.state !== "satisfied") {
    return existing._id;
  }
  await ctx.db.patch(existing._id, {
    ...row,
    canonicalEventId: row.canonicalEventId,
    updatedAt: now,
    venueId: row.venueId,
  });
  return existing._id;
}

/**
 * Additive dual-write beside the legacy source link and receipt. Callers must
 * invoke this inside the same mutation *after* the legacy fence/receipt
 * invariants have been revalidated.
 */
export async function syncSourceOccurrencePlan(options: {
  ctx: MutationCtx;
  plan: SourceOccurrencePlanRecord;
  representativeEvent?: SourceOccurrenceRepresentative;
  satisfiedKey?: string;
  sourceDocument: Doc<"scrapedPosts">;
  supersededKey?: string;
  topologyEpochVerified: boolean;
}): Promise<SyncedSourceOccurrence | null> {
  if (typeof options.topologyEpochVerified !== "boolean") {
    throw new Error("Source-occurrence sync requires an explicit topology epoch classification.");
  }
  assertSourceOccurrenceSyncPlanWithinBounds(options.plan);
  const canonicalSource = canonicalizeSourceUrl(
    "instagram",
    options.sourceDocument.instagramPostUrl,
  );
  if (!canonicalSource.ok) {
    throw new DomainError(
      "SOURCE_NOT_GROUNDED",
      "A first-class source occurrence requires a canonical source URL.",
      { cause: canonicalSource.error },
    );
  }

  let satisfied: SyncedSourceOccurrence | null = null;
  const venueResolutionByClaim = await resolveVenueClaimsForWrite(
    options.ctx,
    options.plan.expectedOccurrences
      .filter((expected) => expected.key !== options.satisfiedKey)
      .map((expected) => expected.venue),
  );
  for (const [ordinal, expected] of options.plan.expectedOccurrences.entries()) {
    const isSatisfied = expected.key === options.satisfiedKey;
    const venueClaim = expected.venue.trim();
    const venueResolution: ConvexVenueResolution | undefined =
      !isSatisfied && venueClaim
        ? venueResolutionByClaim.get(venueClaim)
        : undefined;
    const sourceOccurrenceId = await upsertSourceOccurrenceRow(
      options.ctx,
      buildOccurrenceRow({
        ...(isSatisfied && options.representativeEvent
          ? { canonicalEvent: options.representativeEvent }
          : {}),
        canonicalSourceUrl: canonicalSource.value.canonicalUrl,
        expected,
        occurrenceOrdinal: ordinal,
        plan: options.plan,
        sourceDocument: options.sourceDocument,
        sourceOccurrenceKey: expected.key,
        state: isSatisfied ? "satisfied" : "expected",
        ...(venueResolution ? { venueResolution } : {}),
      }),
    );
    if (isSatisfied) {
      satisfied = {
        canonicalSourceUrl: canonicalSource.value.canonicalUrl,
        sourceOccurrenceId,
      };
    }
  }

  const expectedKeySet = new Set(options.plan.expectedKeys);
  for (const [offset, deferredKey] of options.plan.deferredChildKeys.entries()) {
    if (expectedKeySet.has(deferredKey)) continue;
    await upsertSourceOccurrenceRow(
      options.ctx,
      buildOccurrenceRow({
        canonicalSourceUrl: canonicalSource.value.canonicalUrl,
        occurrenceOrdinal: options.plan.expectedOccurrences.length + offset,
        plan: options.plan,
        sourceDocument: options.sourceDocument,
        sourceOccurrenceKey: deferredKey,
        state: "deferred",
      }),
    );
  }

  const supersededKeys = new Set([
    ...(options.plan.confirmedPastKeys ?? []),
    ...(options.supersededKey ? [options.supersededKey] : []),
  ]);
  for (const supersededKey of supersededKeys) {
    const existing = await options.ctx.db
      .query("sourceOccurrences")
      .withIndex("by_source_occurrence", (q) =>
        q
          .eq("sourceIdentity", options.plan.sourceIdentity)
          .eq("sourceOccurrenceKey", supersededKey),
      )
      .unique();
    if (existing && existing.state !== "superseded") {
      await options.ctx.db.patch(existing._id, {
        state: "superseded",
        updatedAt: Date.now(),
      });
    }
  }

  await markSourceOccurrenceTopologyMutation(options.ctx, {
    verified: options.topologyEpochVerified,
  });
  return satisfied;
}

const candidateSignatureArgs = {
  occurrenceDateKey: v.string(),
  occurrenceSignatureHash: v.string(),
  occurrenceSignatureVersion: v.number(),
  occurrenceTitleFamily: v.string(),
  occurrenceVenueIdentity: v.string(),
};

export const listCanonicalEventCandidates = query({
  args: {
    ...candidateSignatureArgs,
    limit: v.optional(v.number()),
    serviceSecret: v.optional(v.string()),
  },
  returns: canonicalEventCandidatesResultValidator,
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const result = await loadOccurrenceCandidates(ctx.db, args, args.limit);
    return {
      candidates: result.candidates,
      complete: !result.truncated,
      limit: result.limit,
    };
  },
});

/**
 * Compatibility ingress for the legacy ingestion worker. Venue resolution and
 * signature construction happen server-side, so the worker cannot maintain a
 * competing candidate-identity rule or fall back to an unbounded date scan.
 */
export const listCandidatesForNormalizedOccurrence = query({
  args: {
    artists: v.array(v.string()),
    date: v.string(),
    eventType: v.string(),
    limit: v.optional(v.number()),
    serviceSecret: v.optional(v.string()),
    time: v.optional(v.string()),
    title: v.string(),
    venue: v.string(),
    venueInstagramHandle: v.optional(v.string()),
  },
  returns: normalizedOccurrenceCandidatesResultValidator,
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    const venueResolution = await resolveVenueForWrite(
      ctx,
      args.venueInstagramHandle || args.venue,
    );
    if (venueResolution.resolution.status === "ambiguous") {
      return {
        candidates: [] as Doc<"events">[],
        complete: false,
        limit: 0,
        venueResolutionStatus: "ambiguous" as const,
      };
    }
    const signature = toOccurrenceCandidateIndexFields(
      buildOccurrenceSignature({
        artists: args.artists,
        eventType: args.eventType,
        localDate: args.date,
        normalizedVenueIdentity:
          venueResolution.canonicalVenueName ?? args.venue,
        time: args.time,
        title: args.title,
        venueId: venueResolution.venueFields.venueId,
        venueInstagramHandle:
          venueResolution.venueFields.normalizedVenueInstagramHandle ??
          args.venueInstagramHandle,
      }),
    );
    const result = await loadOccurrenceCandidates(ctx.db, signature, args.limit);
    return {
      candidates: result.candidates,
      complete: !result.truncated,
      limit: result.limit,
      venueResolutionStatus:
        venueResolution.resolution.status === "resolved"
          ? ("resolved" as const)
          : ("unresolved" as const),
    };
  },
});

export const listByCanonicalEvent = query({
  args: {
    eventId: v.id("events"),
    paginationOpts: paginationOptsValidator,
    serviceSecret: v.optional(v.string()),
  },
  returns: paginationResultValidator(sourceOccurrenceDocumentValidator),
  handler: async (ctx, args) => {
    await requireAdminOrServiceSecret(ctx, args.serviceSecret);
    return ctx.db
      .query("sourceOccurrences")
      .withIndex("by_canonical_event", (q) => q.eq("canonicalEventId", args.eventId))
      .paginate({
        cursor: args.paginationOpts.cursor,
        numItems: Math.max(1, Math.min(50, Math.trunc(args.paginationOpts.numItems))),
      });
  },
});
