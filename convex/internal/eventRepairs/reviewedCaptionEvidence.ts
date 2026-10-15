import type { Doc, Id } from "../../_generated/dataModel";
import { normalizeHandle } from "../../../lib/pipeline/venue-normalization";

/** Replace an account inference only after an exact reviewed physical venue change. */
export function supersedeReviewedAccountVenueFallback(args: {
  currentFields: Record<string, unknown>;
  event: Pick<Doc<"events">, "venue" | "venueId" | "venueInstagramHandle">;
  venueFields: { venueId?: Id<"venues">; venueInstagramHandle?: string };
  nextVenue: string;
  reviewedAt: number;
  actor: string;
  evidence: string;
}): { fields: Record<string, unknown>; audit: Record<string, unknown> } {
  const { currentFields: fields, event, venueFields } = args;
  const sourceHandle = normalizeHandle(String(fields.sourceGroundingInstagramHandle ?? ""));
  if (
    fields.venueAccountFallbackVersion !== 1 ||
    !event.venueId || !venueFields.venueId || event.venueId === venueFields.venueId ||
    event.venue === args.nextVenue || fields.normalizedVenue !== event.venue ||
    fields.sourceAccountRole !== "venue" || fields.trustedVenueSource !== true ||
    fields.venueSource !== "handle_map" || !sourceHandle ||
    normalizeHandle(event.venueInstagramHandle ?? "") !== sourceHandle
  ) return { fields, audit: {} };
  const supersession = {
    policyVersion: 1,
    reviewedAt: args.reviewedAt,
    reviewedBy: args.actor,
    previousFallback: {
      venueAccountFallbackVersion: fields.venueAccountFallbackVersion,
      normalizedVenue: fields.normalizedVenue,
      venueSource: fields.venueSource,
      trustedVenueSource: fields.trustedVenueSource,
      venueId: event.venueId,
      venueInstagramHandle: event.venueInstagramHandle ?? null,
    },
    venue: args.nextVenue,
    venueId: venueFields.venueId,
    venueInstagramHandle: venueFields.venueInstagramHandle ?? null,
    evidence: args.evidence,
  };
  const nextFields: Record<string, unknown> = { ...fields, venueSource: "human_reviewed", trustedVenueSource: false,
    reviewedVenueAccountFallbackSupersession: supersession };
  delete nextFields.venueAccountFallbackVersion;
  return { fields: nextFields, audit: { reviewedVenueAccountFallbackSupersession: supersession } };
}

/** Compare two explicit calendar dates without inferring an omitted year/day. */
export function reviewedScheduleDateMatchesEventDate(sourceDate: unknown, eventDate: string): boolean {
  if (typeof sourceDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(eventDate)) return false;
  const localDate = sourceDate.match(/^(\d{2})\.(\d{2})\.(\d{4})$/u);
  const sourceIsoDate = localDate ? `${localDate[3]}-${localDate[2]}-${localDate[1]}` : sourceDate;
  if (sourceIsoDate !== eventDate) return false;
  const parsed = new Date(`${eventDate}T12:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === eventDate;
}

/** Match a corrected title to the exact persisted row for its calendar day. */
export function reviewedTitleEvidenceMatchesBoundScheduleRow(args: {
  currentFields: Record<string, unknown>;
  rawExtraction: Record<string, unknown>;
  eventDate: string;
  nextTitle: string;
  titleEvidence: string;
}): boolean {
  const rowIndex = args.currentFields.splitEventIndex;
  const scheduleEntries = args.rawExtraction.schedule_entries;
  const row = Number.isSafeInteger(rowIndex) && Number(rowIndex) >= 1 && Array.isArray(scheduleEntries)
    ? scheduleEntries[(rowIndex as number) - 1]
    : null;
  if (!row || typeof row !== "object" || Array.isArray(row)) return false;
  const sourceText = (row as Record<string, unknown>).source_text;
  const sourceDate = (row as Record<string, unknown>).date;
  if (typeof sourceText !== "string" || !reviewedScheduleDateMatchesEventDate(sourceDate, args.eventDate)) return false;
  const normalizeWhitespace = (value: string) =>
    value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  const foldLetters = (value: string) =>
    normalizeWhitespace(value).normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("sr-Latn");
  return (
    sourceText === args.currentFields.rowSourceText &&
    normalizeWhitespace(sourceText) === args.titleEvidence &&
    foldLetters(sourceText).includes(foldLetters(args.nextTitle))
  );
}

export function assertReviewedCaptionVenueCorrection(
  event: Doc<"events">,
  currentFields: Record<string, unknown>,
  args: {
    captionVenueEvidence?: string;
    expectedTargetVenueHandle?: string;
    targetVenueId?: Id<"venues">;
    nextTitle: string;
    nextTime: string;
    nextArtists: string[];
    nextDescription: string;
  },
) {
  const evidence = args.captionVenueEvidence?.normalize("NFKC").trim();
  const handle = normalizeHandle(args.expectedTargetVenueHandle ?? "");
  const escapedHandle = handle.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const exactHandle = new RegExp(`(?:^|[^a-z0-9._])@${escapedHandle}(?=$|[^a-z0-9._])`, "u");
  const caption = event.sourceCaption?.normalize("NFKC") ?? "";
  if (
    !args.targetVenueId ||
    !handle ||
    evidence !== `@${handle}` ||
    !caption.includes(evidence) ||
    !exactHandle.test(caption) ||
    args.nextTitle !== currentFields.sourceAccountName ||
    args.nextTime !== (event.time ?? "TBD") ||
    JSON.stringify(args.nextArtists) !== JSON.stringify(event.artists) ||
    args.nextDescription !== (event.description ?? "")
  ) {
    throw new Error("Reviewed caption correction requires the exact source account title and caption venue handle, without changing time, artists, or description.");
  }
}
