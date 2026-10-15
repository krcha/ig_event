import type { Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { requireAdminOrServiceSecret } from "../../authz";
import {
  repairReviewedStructuredEventEvidenceHandler,
  type ReviewedStructuredCorrectionVersionArgs,
} from "./reviewedStructuredCorrections";

/** Caption-only title/venue review keeps all existing timing and lineup facts. */
export async function repairReviewedStructuredEventCaptionVenueHandler(
  ctx: MutationCtx,
  args: ReviewedStructuredCorrectionVersionArgs & {
    id: Id<"events">;
    expectedUpdatedAt: number;
    expectedNormalizedFieldsJson: string;
    nextVenue: string;
    targetVenueId: Id<"venues">;
    expectedTargetVenueUpdatedAt: number;
    expectedTargetVenueHandle: string;
    captionVenueEvidence: string;
    moderationNote: string;
    serviceSecret: string;
  },
) {
  const authorization = await requireAdminOrServiceSecret(ctx, args.serviceSecret);
  if (authorization.kind !== "service") {
    throw new Error("Reviewed caption correction requires service authentication.");
  }
  const event = await ctx.db.get(args.id);
  if (!event) throw new Error("Event not found.");
  let currentFields: Record<string, unknown>;
  try {
    currentFields = JSON.parse(event.normalizedFieldsJson ?? "null") as Record<string, unknown>;
  } catch {
    throw new Error("Reviewed caption correction requires valid source evidence.");
  }
  if (!currentFields || typeof currentFields.sourceAccountName !== "string" || !currentFields.sourceAccountName.trim()) {
    throw new Error("Reviewed caption correction requires the persisted source account name.");
  }
  return repairReviewedStructuredEventEvidenceHandler(ctx, {
    ...args,
    nextTitle: currentFields.sourceAccountName,
    nextTime: event.time ?? "TBD",
    nextArtists: event.artists,
    nextDescription: event.description ?? "",
    posterVenueEvidence: "",
    posterTimeEvidence: "",
    posterArtistEvidence: [],
  });
}
