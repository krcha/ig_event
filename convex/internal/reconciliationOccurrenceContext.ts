import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { DomainError } from "../../lib/domain/errors";
import {
  parseStructuredFactsJson,
  projectStructuredFactsToOccurrenceBinding,
} from "../../lib/domain/occurrences/facts";
import {
  parseCanonicalEventPayload,
  type CanonicalEventPayload,
} from "../../lib/domain/occurrences/canonical-event-payload";
import {
  buildOccurrenceSignature,
  toOccurrenceCandidateIndexFields,
  type OccurrenceCandidateIndexFields,
} from "../../lib/domain/occurrences/signature";
import type {
  ReconciliationOccurrence,
  ReconciliationPlan,
} from "../../lib/domain/reconciliation/index";
import { canonicalizeEventType } from "../../lib/taxonomy/venue-types";
import { buildEventOccurrenceIndexPatch } from "../sourceOccurrences";
import {
  projectNormalizedFieldsForSource,
  readSourceAccountIdentityFromNormalizedFields,
  readReconciliationVenueAccountIdentity,
  type ReconciliationProvenanceLink,
  type ReconciliationSourceDocument,
} from "../repositories/reconciliationSourceContext";
import {
  resolveVenueForWrite,
  type VenueDenormalizedFields,
} from "../venueResolver";
import {
  MAX_SOURCE_OCCURRENCE_ARTISTS,
  MAX_SOURCE_OCCURRENCE_STRING_LENGTH,
} from "./sourceOccurrenceReceipts";

export type LegacyOutcome = "attach" | "create" | "update";
export type SourceOccurrenceIntent = "ingest_occurrence" | "moderate";

export type NormalizedOccurrencePayload = {
  artists: string[];
  date: string;
  description?: string;
  eventType: string;
  time?: string;
  title: string;
  venue: string;
};

export type ResolvedVenueFields = {
  canonicalVenueName: string;
  fields: VenueDenormalizedFields;
};

export type CanonicalPatchEnvelope = {
  fieldsToUnset: readonly string[];
  patch: Readonly<Record<string, unknown>>;
};

export function materializeCanonicalPatch(
  plan: Pick<ReconciliationPlan, "canonicalFieldsToUnset" | "canonicalPatch">,
): Readonly<Record<string, unknown>> {
  const patch = { ...(plan.canonicalPatch ?? {}) };
  for (const field of plan.canonicalFieldsToUnset ?? []) {
    if (Object.prototype.hasOwnProperty.call(patch, field)) {
      throw new DomainError(
        "RECONCILIATION_PLAN_INVALID",
        "Canonical patch cannot both set and unset the same field.",
        { details: { field } },
      );
    }
    patch[field] = undefined;
  }
  return patch;
}

export function storedOccurrenceIndexFields(
  occurrence: Doc<"sourceOccurrences">,
): OccurrenceCandidateIndexFields {
  return {
    occurrenceArtistFingerprint: occurrence.occurrenceArtistFingerprint,
    occurrenceDateKey: occurrence.occurrenceDateKey,
    occurrenceEventType: occurrence.occurrenceEventType,
    occurrenceSignatureHash: occurrence.occurrenceSignatureHash,
    occurrenceSignatureVersion: occurrence.occurrenceSignatureVersion,
    occurrenceTimeIdentity: occurrence.occurrenceTimeIdentity,
    occurrenceTitleFamily: occurrence.occurrenceTitleFamily,
    occurrenceVenueIdentity: occurrence.occurrenceVenueIdentity,
  };
}

export function canonicalPatchFromSourceOccurrence(
  occurrence: Doc<"sourceOccurrences">,
  normalized: NormalizedOccurrencePayload,
  venueFields: ResolvedVenueFields,
  sourceDocument: ReconciliationSourceDocument,
): CanonicalPatchEnvelope {
  const canonicalPayload = readCanonicalEventPayload(occurrence);
  const normalizedFieldsJson = projectNormalizedFieldsForSource(
    sourceDocument,
    canonicalPayload?.normalizedFieldsJson ??
      occurrence.normalizedOccurrenceJson,
  );
  const mutationShapingPatch: Readonly<Record<string, unknown>> = {
    artists: normalized.artists,
    canonicalSourceUrl: occurrence.canonicalSourceUrl,
    date: normalized.date,
    ...((canonicalPayload?.description ?? normalized.description)
      ? {
          description:
            canonicalPayload?.description ?? normalized.description,
        }
      : {}),
    eventType: normalized.eventType,
    normalizedFieldsJson,
    ...sourceDocument.canonicalEventFields,
    ...storedOccurrenceIndexFields(occurrence),
    sourceOccurrenceKey: occurrence.sourceOccurrenceKey,
    // `undefined` deliberately removes a previously stored optional time. The
    // occurrence-signature fields describe this incoming no-time value, so
    // retaining an old time would make the canonical lookup indexes stale.
    ...(canonicalPayload
      ? {
          dateEvidenceIsRelative:
            canonicalPayload.dateEvidenceIsRelative,
          dateEvidenceResolvedDate:
            canonicalPayload.dateEvidenceResolvedDate,
          dateEvidenceSource: canonicalPayload.dateEvidenceSource,
          dateEvidenceText: canonicalPayload.dateEvidenceText,
          sourceConflictFields: [...canonicalPayload.sourceConflictFields],
          status: canonicalPayload.requestedStatus,
          ticketPrice: canonicalPayload.ticketPrice,
          time: canonicalPayload.time,
          timeConfidence: canonicalPayload.timeConfidence,
          timeEvidenceKind: canonicalPayload.timeEvidenceKind,
          timeEvidenceText: canonicalPayload.timeEvidenceText,
          timeSource: canonicalPayload.timeSource,
          timeStatus: canonicalPayload.timeStatus,
        }
      : { time: normalized.time }),
    title: normalized.title,
    venue: venueFields.canonicalVenueName,
    ...venueFields.fields,
  };
  const fieldsToUnset = Object.entries(mutationShapingPatch)
    .filter(([, value]) => value === undefined)
    .map(([field]) => field)
    .sort();
  return {
    fieldsToUnset,
    patch: Object.fromEntries(
      Object.entries(mutationShapingPatch).filter(
        ([, value]) => value !== undefined,
      ),
    ),
  };
}

/**
 * A present payload is authoritative and must parse. Missing payloads are
 * tolerated only for migrated compatibility occurrences created before the
 * canonical-event contract existed.
 */
export function readCanonicalEventPayload(
  occurrence: Pick<Doc<"sourceOccurrences">, "canonicalEventJson" | "factsJson">,
): CanonicalEventPayload | null {
  const payload = parseCanonicalEventPayload(occurrence.canonicalEventJson);
  if (!payload && occurrence.canonicalEventJson !== undefined) {
    throw new DomainError(
      "OCCURRENCE_INCOMPLETE",
      "Source occurrence canonical-event payload is invalid.",
    );
  }
  if (!payload) return null;
  const facts = parseStructuredFactsJson(occurrence.factsJson);
  if (!facts || payload.requestedStatus !== facts.policy.approvalDisposition) {
    throw new DomainError(
      "RECONCILIATION_CONFLICT",
      "Canonical-event moderation request diverges from structured facts.",
    );
  }
  return payload;
}

function parseObject(
  value: string | undefined,
): Record<string, unknown> | null {
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

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length > MAX_SOURCE_OCCURRENCE_STRING_LENGTH) {
    throw new DomainError(
      "OCCURRENCE_INCOMPLETE",
      "Normalized occurrence string exceeds the hard bound.",
    );
  }
  return value.trim() || null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  if (value.length > MAX_SOURCE_OCCURRENCE_ARTISTS) {
    throw new DomainError(
      "OCCURRENCE_INCOMPLETE",
      "Normalized occurrence artist set exceeds the hard bound.",
    );
  }
  const artists = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  if (
    artists.length !== value.length ||
    artists.some(
      (artist) => artist.length > MAX_SOURCE_OCCURRENCE_STRING_LENGTH,
    )
  ) {
    throw new DomainError(
      "OCCURRENCE_INCOMPLETE",
      "Normalized occurrence artists contain invalid strings.",
    );
  }
  return artists;
}

export function readNormalizedOccurrence(
  occurrence: Doc<"sourceOccurrences">,
): NormalizedOccurrencePayload {
  const normalized = parseObject(occurrence.normalizedOccurrenceJson);
  const facts = parseObject(occurrence.factsJson);
  const structuredFacts = parseStructuredFactsJson(occurrence.factsJson);
  const factBinding = structuredFacts
    ? projectStructuredFactsToOccurrenceBinding(structuredFacts)
    : null;
  const title =
    readString(normalized?.title) ??
    readString(factBinding?.title) ??
    readString(facts?.title);
  const date =
    readString(normalized?.date) ??
    readString(factBinding?.date) ??
    readString(facts?.date);
  const venue =
    readString(normalized?.venue) ??
    readString(factBinding?.venue) ??
    readString(facts?.venue) ??
    "";
  if (!title || !date) {
    throw new DomainError(
      "OCCURRENCE_INCOMPLETE",
      "Source occurrence is missing a normalized title or date.",
      { details: { sourceOccurrenceId: occurrence._id } },
    );
  }
  return {
    artists: readStringArray(
      normalized?.artists ?? factBinding?.artists ?? facts?.artists,
    ),
    date,
    ...(readString(normalized?.description ?? facts?.description)
      ? {
          description: readString(
            normalized?.description ?? facts?.description,
          )!,
        }
      : {}),
    eventType: canonicalizeEventType(
      readString(
        normalized?.eventType ?? structuredFacts?.eventTypeClaim ?? facts?.eventType,
      ) ??
        occurrence.occurrenceEventType,
    ),
    ...(readString(normalized?.time ?? factBinding?.time ?? facts?.time)
      ? {
          time: readString(
            normalized?.time ?? factBinding?.time ?? facts?.time,
          )!,
        }
      : {}),
    title,
    venue,
  };
}

export function assertStoredSignature(
  occurrence: Doc<"sourceOccurrences">,
  normalized: NormalizedOccurrencePayload,
): void {
  const recomputed = toOccurrenceCandidateIndexFields(
    buildOccurrenceSignature({
      artists: normalized.artists,
      eventType: normalized.eventType,
      localDate: normalized.date,
      normalizedVenueIdentity: occurrence.occurrenceVenueIdentity.startsWith(
        "name:",
      )
        ? occurrence.occurrenceVenueIdentity.slice("name:".length)
        : normalized.venue,
      time: normalized.time,
      title: normalized.title,
      venueId: occurrence.venueId,
      venueInstagramHandle: occurrence.occurrenceVenueIdentity.startsWith(
        "instagram:",
      )
        ? occurrence.occurrenceVenueIdentity.slice("instagram:".length)
        : undefined,
    }),
  );
  const stored = storedOccurrenceIndexFields(occurrence);
  if (JSON.stringify(recomputed) !== JSON.stringify(stored)) {
    throw new DomainError(
      "RECONCILIATION_CONFLICT",
      "Stored occurrence signature no longer matches normalized facts.",
      { details: { sourceOccurrenceId: occurrence._id } },
    );
  }
}

export function assertCanonicalEventSignature(event: Doc<"events">): void {
  const expected = buildEventOccurrenceIndexPatch(event);
  for (const [field, value] of Object.entries(expected)) {
    if (
      JSON.stringify((event as unknown as Record<string, unknown>)[field]) !==
      JSON.stringify(value)
    ) {
      throw new DomainError(
        "RECONCILIATION_PLAN_INVALID",
        "Canonical event occurrence signature does not match its effective fields.",
        { details: { eventId: event._id, field } },
      );
    }
  }
}

export function eventAsOccurrence(
  event: Doc<"events">,
  exactSource?: ReconciliationProvenanceLink,
  sourceAccountIdentity?: string,
): ReconciliationOccurrence {
  return {
    artists: event.artists,
    canonicalSourceUrl: event.canonicalSourceUrl,
    date: event.date,
    eventId: String(event._id),
    eventType: event.eventType,
    id: String(event._id),
    normalizedFieldsJson: event.normalizedFieldsJson,
    normalizedVenueIdentity: event.normalizedVenueIdentity,
    sourceIdentity: exactSource?.sourceIdentity,
    sourceAccountHandle:
      sourceAccountIdentity ??
      exactSource?.sourceAccountIdentity ??
      readSourceAccountIdentityFromNormalizedFields(event.normalizedFieldsJson),
    sourceOccurrenceKey:
      exactSource?.sourceOccurrenceKey ?? event.sourceOccurrenceKey,
    status: event.status,
    time: event.time,
    title: event.title,
    updatedAt: event.updatedAt,
    venue: event.venue,
    venueAccountIdentity: readReconciliationVenueAccountIdentity(event),
    venueId: event.venueId ? String(event.venueId) : null,
  };
}

export function sourceAsOccurrence(
  occurrence: Doc<"sourceOccurrences">,
  normalized: NormalizedOccurrencePayload,
  sourceDocument: ReconciliationSourceDocument,
): ReconciliationOccurrence {
  const normalizedFieldsJson = projectNormalizedFieldsForSource(
    sourceDocument,
    occurrence.normalizedOccurrenceJson,
  );
  return {
    artists: normalized.artists,
    canonicalSourceUrl: occurrence.canonicalSourceUrl,
    date: normalized.date,
    eventId: occurrence.canonicalEventId
      ? String(occurrence.canonicalEventId)
      : undefined,
    eventType: normalized.eventType,
    id: String(occurrence._id),
    normalizedFieldsJson,
    normalizedVenueIdentity: occurrence.occurrenceVenueIdentity,
    sourceIdentity: occurrence.sourceIdentity,
    sourceAccountHandle: sourceDocument.accountIdentity,
    sourceOccurrenceKey: occurrence.sourceOccurrenceKey,
    sourceRevision: occurrence.sourceRevision,
    time: normalized.time,
    title: normalized.title,
    venue: normalized.venue,
    venueId: occurrence.venueId ? String(occurrence.venueId) : null,
  };
}

export async function loadVenueFields(
  ctx: MutationCtx,
  occurrence: Doc<"sourceOccurrences">,
  normalizedVenue: string,
): Promise<ResolvedVenueFields | null> {
  if (occurrence.venueResolutionStatus !== "resolved" || !occurrence.venueId) {
    return null;
  }
  const storedVenue = await ctx.db.get(occurrence.venueId);
  if (!storedVenue) return null;
  const identityClaim = occurrence.occurrenceVenueIdentity.startsWith(
    "instagram:",
  )
    ? `@${occurrence.occurrenceVenueIdentity.slice("instagram:".length)}`
    : occurrence.occurrenceVenueIdentity.startsWith("name:")
      ? occurrence.occurrenceVenueIdentity.slice("name:".length)
      : occurrence.occurrenceVenueIdentity.startsWith("id:")
        ? storedVenue.name
        : normalizedVenue;
  const resolution = await resolveVenueForWrite(
    ctx,
    identityClaim || normalizedVenue,
  );
  return resolution.resolution.status === "resolved" &&
    resolution.resolution.venue.id === String(occurrence.venueId)
    ? {
        canonicalVenueName:
          resolution.canonicalVenueName ?? resolution.resolution.venue.name,
        fields: resolution.venueFields,
      }
    : null;
}
