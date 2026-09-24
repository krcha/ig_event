import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { adaptInstagramScrapedPostToSourceDocument } from "../../lib/domain/source-documents";
import { buildInstagramSourceOccurrenceFingerprint } from "../../lib/domain/occurrences/source-fingerprint";
import { sourceOccurrenceRepresentativeMatchesExpected } from "../../lib/events/source-occurrence-representation";
import { normalizeHandle } from "../../lib/pipeline/venue-normalization";
import { sourceOccurrenceProvenanceRepository } from "../repositories/sourceOccurrenceProvenance";

type ReadCtx = QueryCtx | MutationCtx;

function parseFields(value: string | undefined): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value ?? "null");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function comparable(value: unknown): string {
  return typeof value === "string"
    ? value.normalize("NFKC").trim().replace(/\s+/gu, " ")
    : "";
}

function sourceDateToIso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/u.test(text)) return text;
  const match = /^(\d{1,2})\.(\d{1,2})\.(\d{4})\.?$/u.exec(text);
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

type CollisionSourceRow = {
  source_text?: unknown;
  title?: unknown;
  date?: unknown;
  time?: unknown;
  venue?: unknown;
  artists?: unknown;
};

/** The planner's coarse key may collide for two distinct poster schedule rows.
 * Only the exact current source row and distinct, satisfied receipt bindings
 * can discharge that ambiguity; an ordinal alone has no authority. */
export function hasExactSourceCollisionOrdinalProof(
  event: Doc<"events">,
  fields: Record<string, unknown>,
  sourceAnalysisJson: string,
  receipt: Doc<"instagramSourceOccurrenceReceipts">,
): boolean {
  const ordinal = fields.sourceOccurrenceCollisionOrdinal;
  const splitIndex = fields.splitEventIndex;
  const rowText = fields.rowSourceText;
  const expected = receipt.expectedOccurrences ?? [];
  const ownExpected = expected.find((item) => item.key === event.sourceOccurrenceKey);
  if (
    fields.sourceOccurrenceAmbiguousProvenance !== true ||
    !Number.isSafeInteger(ordinal) || Number(ordinal) < 1 ||
    !Number.isSafeInteger(splitIndex) || Number(splitIndex) < 1 ||
    typeof rowText !== "string" || !rowText.trim() || rowText.length > 4_096 ||
    !ownExpected || expected.length < 2 ||
    new Set(receipt.satisfiedOccurrences.map((item) => item.eventId)).size !== expected.length
  ) return false;

  let raw: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(sourceAnalysisJson);
    raw = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>) : null;
  } catch { return false; }
  const entries = raw?.schedule_entries;
  if (!Array.isArray(entries) || entries.length > 64 || Number(splitIndex) > entries.length) {
    return false;
  }
  const rows = entries.filter(
    (entry): entry is CollisionSourceRow =>
      entry !== null && typeof entry === "object" && !Array.isArray(entry),
  );
  if (rows.length !== entries.length) return false;
  const row = rows[Number(splitIndex) - 1];
  const ownDate = sourceDateToIso(row?.date);
  const ownTitle = comparable(row?.title);
  const ownVenue = comparable(row?.venue);
  const ownArtists = Array.isArray(row?.artists) &&
    row.artists.every((artist) => typeof artist === "string")
    ? row.artists.map(comparable) : null;
  if (
    !row || row.source_text !== rowText ||
    rows.filter((item) => item.source_text === rowText).length !== 1 ||
    ownDate !== event.date || ownDate !== ownExpected.date ||
    !ownTitle || ownTitle !== comparable(event.title) ||
    ownTitle !== comparable(ownExpected.title) ||
    !ownVenue || ownVenue !== comparable(event.venue) ||
    ownVenue !== comparable(ownExpected.venue) ||
    !ownArtists ||
    JSON.stringify(ownArtists) !== JSON.stringify(event.artists.map(comparable)) ||
    JSON.stringify(ownArtists) !== JSON.stringify(ownExpected.artists.map(comparable)) ||
    !(row.time === "" && event.time === "TBD" && ownExpected.time === "TBD") &&
      comparable(row.time) !== comparable(event.time)
  ) return false;

  const bindingSignatures = expected.map((item) => JSON.stringify([
    item.date, comparable(item.time), comparable(item.title),
    comparable(item.venue), item.artists.map(comparable),
  ]));
  if (new Set(bindingSignatures).size !== expected.length) return false;
  return expected.some((other) =>
    other.key !== ownExpected.key &&
    other.date === ownExpected.date &&
    comparable(other.venue) === ownVenue &&
    comparable(other.title) !== ownTitle &&
    receipt.satisfiedOccurrences.some((item) =>
      item.key === other.key && item.eventId !== event._id,
    ) &&
    rows.some((otherRow) =>
      otherRow !== row &&
      typeof otherRow.source_text === "string" &&
      otherRow.source_text !== rowText &&
      sourceDateToIso(otherRow.date) === other.date &&
      comparable(otherRow.venue) === ownVenue &&
      comparable(otherRow.title) === comparable(other.title),
    ),
  );
}

/**
 * A server-verified unique approval must remain bound to the current source
 * generation and a fully satisfied, internally consistent occurrence receipt.
 * Public grounding repeats this proof so later source or topology drift hides
 * the event instead of trusting a stale approval marker.
 */
export async function hasCompleteAutomaticUniqueSourceProof(
  ctx: ReadCtx,
  event: Doc<"events">,
): Promise<boolean> {
  const fields = parseFields(event.normalizedFieldsJson);
  if (!fields) return false;
  const handle = normalizeHandle(
    typeof fields?.sourceGroundingInstagramHandle === "string"
      ? fields.sourceGroundingInstagramHandle
      : "",
  );
  const postId = event.instagramPostId?.trim() ?? "";
  const occurrenceKey = event.sourceOccurrenceKey?.trim() ?? "";
  const attestedKey = fields?.sourceOccurrenceKey;
  const attestedFingerprint = fields?.sourceOccurrenceSourceFingerprint;
  if (
    !handle || !postId || !occurrenceKey ||
    attestedKey !== occurrenceKey ||
    typeof attestedFingerprint !== "string" || !attestedFingerprint
  ) return false;

  const sourceRows = await ctx.db
    .query("scrapedPosts")
    .withIndex("by_handle_postId", (q) => q.eq("handle", handle).eq("postId", postId))
    .take(2);
  if (sourceRows.length !== 1) return false;
  const source = sourceRows[0]!;
  if (
    normalizeHandle(source.username) !== handle ||
    source.analysisRevision !== (source.sourceRevision ?? 1) ||
    source.analysisContractVersion !== "event_evidence_v2" ||
    source.analysisIsEvent !== true ||
    !source.analysisModel?.startsWith("gpt-5-mini") ||
    !event.rawExtractionJson ||
    typeof source.analysisResultJson !== "string" ||
    event.rawExtractionJson !== source.analysisResultJson
  ) return false;

  let sourceIdentity: string;
  try {
    sourceIdentity = adaptInstagramScrapedPostToSourceDocument(source).sourceIdentity;
  } catch {
    return false;
  }
  const fingerprint = buildInstagramSourceOccurrenceFingerprint(source);
  if (attestedFingerprint !== fingerprint) return false;

  let topology: Awaited<ReturnType<typeof sourceOccurrenceProvenanceRepository.loadAndAssertEventOccurrenceTopology>>;
  try {
    topology = await sourceOccurrenceProvenanceRepository.loadAndAssertEventOccurrenceTopology(
      ctx,
      event._id,
    );
  } catch {
    return false;
  }
  const links = topology.links.filter(
    (link) => link.sourceIdentity === sourceIdentity &&
      link.sourceOccurrenceKey === occurrenceKey &&
      link.sourceFingerprint === fingerprint &&
      link.eventId === event._id,
  );
  const receipts = topology.receipts.filter(
    (receipt) => receipt.sourceIdentity === sourceIdentity &&
      receipt.sourceFingerprint === fingerprint,
  );
  if (links.length !== 1 || receipts.length !== 1) return false;
  const receipt = receipts[0]!;
  const expected = receipt.expectedOccurrences ?? [];
  const expectedKeys = new Set(receipt.expectedKeys);
  if (
    receipt.deferredChildCount !== 0 ||
    receipt.deferredChildKeys.length !== 0 ||
    expected.length === 0 ||
    expected.length !== expectedKeys.size ||
    receipt.satisfiedKeys.length !== expectedKeys.size ||
    receipt.satisfiedOccurrences.length !== expectedKeys.size ||
    receipt.satisfiedKeys.some((key) => !expectedKeys.has(key)) ||
    receipt.satisfiedOccurrences.some((item) => !expectedKeys.has(item.key))
  ) return false;

  for (const binding of expected) {
    const satisfactions = receipt.satisfiedOccurrences.filter(
      (item) => item.key === binding.key,
    );
    if (satisfactions.length !== 1) return false;
    const representative = await ctx.db.get(satisfactions[0]!.eventId);
    if (!sourceOccurrenceRepresentativeMatchesExpected(representative, binding)) {
      return false;
    }
  }
  const ownSatisfaction = receipt.satisfiedOccurrences.filter(
    (item) => item.key === occurrenceKey && item.eventId === event._id,
  );
  return ownSatisfaction.length === 1 &&
    (fields?.sourceOccurrenceAmbiguousProvenance !== true ||
      hasExactSourceCollisionOrdinalProof(
        event,
        fields,
        source.analysisResultJson,
        receipt,
      ));
}
