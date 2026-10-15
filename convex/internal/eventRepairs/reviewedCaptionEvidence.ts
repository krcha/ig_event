import type { Doc, Id } from "../../_generated/dataModel";
import { normalizeHandle } from "../../../lib/pipeline/venue-normalization";

/** Compare two explicit calendar dates without inferring an omitted year/day. */
export function reviewedScheduleDateMatchesEventDate(sourceDate: unknown, eventDate: string): boolean {
  if (typeof sourceDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(eventDate)) return false;
  const localDate = sourceDate.match(/^(\d{2})\.(\d{2})\.(\d{4})$/u);
  const sourceIsoDate = localDate ? `${localDate[3]}-${localDate[2]}-${localDate[1]}` : sourceDate;
  if (sourceIsoDate !== eventDate) return false;
  const parsed = new Date(`${eventDate}T12:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === eventDate;
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
