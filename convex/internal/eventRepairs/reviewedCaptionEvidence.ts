import type { Doc, Id } from "../../_generated/dataModel";
import { normalizeHandle } from "../../../lib/pipeline/venue-normalization";

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
