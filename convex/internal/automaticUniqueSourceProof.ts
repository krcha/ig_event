import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { adaptInstagramScrapedPostToSourceDocument } from "../../lib/domain/source-documents";
import { buildInstagramSourceOccurrenceFingerprint } from "../../lib/domain/occurrences/source-fingerprint";
import { sourceOccurrenceRepresentativeMatchesExpected } from "../../lib/events/source-occurrence-representation";
import { getBelgradeDayKey } from "../../lib/pipeline/belgrade-day-key";
import { normalizeHandle, toSearchableText } from "../../lib/pipeline/venue-normalization";
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

function isValidPastBelgradeDate(value: string, currentBelgradeDay: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value) || value >= currentBelgradeDay) {
    return false;
  }
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() + 1 === month &&
    parsed.getUTCDate() === day;
}

type CollisionSourceRow = {
  source_text?: unknown;
  title?: unknown;
  date?: unknown;
  time?: unknown;
  venue?: unknown;
  artists?: unknown;
  date_evidence?: unknown;
};
type ExpectedReceiptBinding = NonNullable<
  Doc<"instagramSourceOccurrenceReceipts">["expectedOccurrences"]
>[number];

function normalizedArtists(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((artist) => typeof artist !== "string")) {
    return null;
  }
  return value.map((artist: string) => toSearchableText(artist)).sort();
}

function sourceRowMatchesExpectedBinding(
  row: CollisionSourceRow,
  binding: ExpectedReceiptBinding,
): boolean {
  if (typeof row.title !== "string" || typeof row.venue !== "string") {
    return false;
  }
  const artists = normalizedArtists(row.artists);
  const expectedArtists = normalizedArtists(binding.artists);
  const evidence = row.date_evidence && typeof row.date_evidence === "object" &&
    !Array.isArray(row.date_evidence)
    ? row.date_evidence as Record<string, unknown> : null;
  const expectedTime = comparable(binding.time).toLowerCase();
  const rawTime = comparable(row.time).toLowerCase();
  return sourceDateToIso(row.date) === binding.date &&
    evidence?.resolved_date === binding.date &&
    toSearchableText(row.title) === toSearchableText(binding.title) &&
    toSearchableText(row.venue) === toSearchableText(binding.venue) &&
    artists !== null && expectedArtists !== null &&
    JSON.stringify(artists) === JSON.stringify(expectedArtists) &&
    (!expectedTime ||
      (expectedTime === "tbd" ? !rawTime || rawTime === "tbd" : rawTime === expectedTime));
}

function skippedPastBindingsMatchCurrentSourceRows(
  sourceAnalysisJson: string,
  sourceCaption: string | undefined,
  sourceAltText: string | undefined,
  expected: NonNullable<Doc<"instagramSourceOccurrenceReceipts">["expectedOccurrences"]>,
  missingKeys: ReadonlySet<string>,
): boolean {
  let raw: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(sourceAnalysisJson);
    raw = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown> : null;
  } catch { return false; }
  const entries = raw?.schedule_entries;
  if (!Array.isArray(entries) || entries.length < 2 || entries.length > 64 ||
    entries.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry))) {
    return false;
  }
  const rows = entries as CollisionSourceRow[];
  const sourceTexts = [sourceCaption, sourceAltText]
    .filter((value): value is string => typeof value === "string")
    .map((value) => comparable(value).toLocaleLowerCase("sr-Latn"));
  const matchedRows = new Set<number>();
  for (const binding of expected.filter((item) => missingKeys.has(item.key))) {
    const matches = rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => sourceRowMatchesExpectedBinding(row, binding));
    if (matches.length !== 1 || matchedRows.has(matches[0]!.index)) return false;
    const { row, index } = matches[0]!;
    const sourceLine = comparable(row.source_text).toLocaleLowerCase("sr-Latn");
    if (
      !sourceLine ||
      !sourceTexts.some((text) =>
        ` ${text} `.includes(` ${sourceLine} `)
      ) ||
      expected.some((other) =>
        other.key !== binding.key && sourceRowMatchesExpectedBinding(row, other)
      )
    ) return false;
    matchedRows.add(index);
  }
  return matchedRows.size === missingKeys.size;
}

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
 * generation and an internally consistent occurrence receipt. An unsatisfied
 * sibling can be ignored only after its expected date is past on the
 * Belgrade calendar and strictly before this event's date, with a distinct
 * current source row proving its date and identity. The current child and
 * any collision-ambiguous receipt still need
 * complete proof.
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
  const satisfiedKeys = new Set(receipt.satisfiedKeys);
  if (
    receipt.deferredChildCount !== 0 ||
    receipt.deferredChildKeys.length !== 0 ||
    expected.length === 0 ||
    expected.length !== expectedKeys.size ||
    expected.some((item) => !expectedKeys.has(item.key)) ||
    satisfiedKeys.size !== receipt.satisfiedKeys.length ||
    receipt.satisfiedOccurrences.length !== satisfiedKeys.size ||
    receipt.satisfiedKeys.some((key) => !expectedKeys.has(key)) ||
    receipt.satisfiedOccurrences.some((item) =>
      !expectedKeys.has(item.key) || !satisfiedKeys.has(item.key)
    )
  ) return false;

  const missing = expected.filter((item) => !satisfiedKeys.has(item.key));
  const currentBelgradeDay = missing.length > 0
    ? getBelgradeDayKey(Date.now())
    : "";
  if (
    (fields.sourceOccurrenceAmbiguousProvenance === true && missing.length > 0) ||
    missing.some((item) =>
      !isValidPastBelgradeDate(item.date, currentBelgradeDay) ||
      item.date >= event.date
    ) ||
    (missing.length > 0 && !skippedPastBindingsMatchCurrentSourceRows(
      source.analysisResultJson,
      source.caption,
      source.altText,
      expected,
      new Set(missing.map((item) => item.key)),
    ))
  ) return false;

  for (const binding of expected.filter((item) => satisfiedKeys.has(item.key))) {
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
