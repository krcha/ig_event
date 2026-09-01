import { buildTitleFamilySlug } from "../../events/deduplication-shared";
import { normalizeEventTime } from "../../events/event-time";
import { canonicalizeEventType } from "../../taxonomy/venue-types";
import { normalizeHandle, toSearchableText } from "../venues/normalization";

export const OCCURRENCE_SIGNATURE_VERSION = 1 as const;

export type OccurrenceSignatureInput = {
  artists?: readonly string[];
  eventType?: string | null;
  localDate: string;
  normalizedVenueIdentity?: string | null;
  time?: string | null;
  title: string;
  venueId?: string | null;
  venueInstagramHandle?: string | null;
};

export type OccurrenceSignature = {
  artistFingerprint: string;
  eventType: string;
  localDate: string;
  signatureHash: string;
  timeIdentity: string;
  titleFamily: string;
  venueIdentity: string;
  version: typeof OCCURRENCE_SIGNATURE_VERSION;
};

function normalizeLocalDate(value: string): string {
  const normalized = value.trim();
  return /^\d{4}-\d{2}-\d{2}$/u.test(normalized) ? normalized : "unknown-date";
}

function buildVenueIdentity(input: OccurrenceSignatureInput): string {
  const venueId = input.venueId?.trim();
  if (venueId) return `id:${venueId}`;

  const handle = normalizeHandle(input.venueInstagramHandle ?? "");
  if (handle) return `instagram:${handle}`;

  const normalizedName = toSearchableText(input.normalizedVenueIdentity ?? "");
  return normalizedName ? `name:${normalizedName}` : "unknown-venue";
}

function buildTimeIdentity(value: string | null | undefined): string {
  const normalized = normalizeEventTime(value);
  if (!normalized.startLabel) return "unknown-time";
  return normalized.endLabel
    ? `${normalized.startLabel}-${normalized.endLabel}`
    : normalized.startLabel;
}

function buildArtistFingerprint(values: readonly string[]): string {
  return [...new Set(values.map(toSearchableText).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right))
    .slice(0, 12)
    .join("+") || "unknown-artists";
}

/** Stable non-cryptographic digest. It only bounds an index key; every
 * candidate still goes through semantic reconciliation. */
export function digestOccurrenceSignature(value: string): string {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193) >>> 0;
    right = Math.imul(right ^ (code + index), 0x85ebca6b) >>> 0;
  }
  return `${left.toString(16).padStart(8, "0")}${right
    .toString(16)
    .padStart(8, "0")}`;
}

export function buildOccurrenceSignature(
  input: OccurrenceSignatureInput,
): OccurrenceSignature {
  const localDate = normalizeLocalDate(input.localDate);
  const venueIdentity = buildVenueIdentity(input);
  const timeIdentity = buildTimeIdentity(input.time);
  const titleFamily = buildTitleFamilySlug(input.title) || "unknown-title";
  const artistFingerprint = buildArtistFingerprint(input.artists ?? []);
  const eventType = canonicalizeEventType(input.eventType);
  const canonical = [
    `v${OCCURRENCE_SIGNATURE_VERSION}`,
    localDate,
    venueIdentity,
    timeIdentity,
    titleFamily,
    artistFingerprint,
    eventType,
  ].join("|");

  return {
    artistFingerprint,
    eventType,
    localDate,
    signatureHash: digestOccurrenceSignature(canonical),
    timeIdentity,
    titleFamily,
    venueIdentity,
    version: OCCURRENCE_SIGNATURE_VERSION,
  };
}

export type OccurrenceCandidateIndexFields = {
  occurrenceArtistFingerprint: string;
  occurrenceDateKey: string;
  occurrenceEventType: string;
  occurrenceSignatureHash: string;
  occurrenceSignatureVersion: number;
  occurrenceTimeIdentity: string;
  occurrenceTitleFamily: string;
  occurrenceVenueIdentity: string;
};

export function toOccurrenceCandidateIndexFields(
  signature: OccurrenceSignature,
): OccurrenceCandidateIndexFields {
  return {
    occurrenceArtistFingerprint: signature.artistFingerprint,
    occurrenceDateKey: signature.localDate,
    occurrenceEventType: signature.eventType,
    occurrenceSignatureHash: signature.signatureHash,
    occurrenceSignatureVersion: signature.version,
    occurrenceTimeIdentity: signature.timeIdentity,
    occurrenceTitleFamily: signature.titleFamily,
    occurrenceVenueIdentity: signature.venueIdentity,
  };
}
