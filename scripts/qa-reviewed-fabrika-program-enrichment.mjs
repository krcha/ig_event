import assert from "node:assert/strict";
import {
  buildReviewedFabrikaProgramEnrichmentPatch,
  FABRIKA_PROGRAM_REVIEWS,
  FABRIKA_WEEKLY_POST_URL,
} from "../lib/events/reviewed-fabrika-program-enrichment.ts";

for (const night of ["thursday", "friday", "saturday"]) {
  const review = FABRIKA_PROGRAM_REVIEWS[night];
  const caption = [
    ...review.captionAnchors,
    "21:00 | 🎟️: 500 rsd",
    "📍Radnička 5N, Ada Ciganlija",
  ].join("\n");
  const primary = {
    _id: review.primaryId,
    status: "approved",
    title: review.primaryTitle,
    date: review.date,
    time: review.primaryTime,
    venue: "Fabrika Alternativne Kulturne Scene",
    venueId: review.primaryVenueId,
    venueInstagramHandle: "faks_beograd",
    artists: [],
    eventType: "nightlife",
    instagramPostUrl: FABRIKA_WEEKLY_POST_URL,
    description: review.priorDescription,
    ticketPrice: night === "thursday" ? "500 RSD" : undefined,
  };
  const direct = {
    _id: review.directId,
    status: "pending",
    title: review.directTitle,
    date: review.date,
    time: review.directTime,
    venue: review.directVenue,
    venueId: night === "friday" ? undefined : review.primaryVenueId,
    venueInstagramHandle: night === "friday" ? undefined : "faks_beograd",
    artists: [...review.artists],
    eventType: review.directEventType,
    instagramPostUrl: review.directUrl,
    sourceCaption: caption,
    ticketPrice: "500 rsd",
  };
  const patch = buildReviewedFabrikaProgramEnrichmentPatch(
    night,
    primary,
    direct,
    caption,
  );
  assert.deepEqual(patch, {
    description: review.description,
    ticketPrice: "500 RSD",
    reviewedSourceUpdate: {
      text: review.sourceUpdateText,
      sourceUrl: review.directUrl,
      sourceEventId: review.directId,
    },
    alreadyDone: false,
  });
  assert.equal(patch.reviewedSourceUpdate.text.length <= 150, true);
  assert.equal(
    buildReviewedFabrikaProgramEnrichmentPatch(
      night,
      {
        ...primary,
        description: patch.description,
        ticketPrice: patch.ticketPrice,
        reviewedSourceUpdate: patch.reviewedSourceUpdate,
      },
      direct,
      caption,
    ).alreadyDone,
    true,
  );

  for (const [primaryChange, directChange, persistedCaption] of [
    [{ status: "pending" }, {}, caption],
    [{ title: "Different event" }, {}, caption],
    [{ date: "2026-10-01" }, {}, caption],
    [{ time: "20:00-03:00" }, {}, caption],
    [{ venueId: "another-venue" }, {}, caption],
    [{ artists: ["unsupported"] }, {}, caption],
    [{ ticketPrice: "free" }, {}, caption],
    [{ reviewedSourceUpdate: { text: "Unreviewed", sourceUrl: review.directUrl, sourceEventId: review.directId } }, {}, caption],
    [{}, { status: "approved" }, caption],
    [{}, { date: "2026-10-01" }, caption],
    [{}, { time: "22:00" }, caption],
    [{}, { venue: "Another venue" }, caption],
    [{}, { artists: ["@another_artist"] }, caption],
    [{}, { instagramPostUrl: FABRIKA_WEEKLY_POST_URL }, caption],
    [{}, { ticketPrice: "free" }, caption],
    [{}, { sourceCaption: "changed" }, caption],
    [{}, {}, caption.replace("500 rsd", "free")],
    [{}, {}, caption.replace(review.captionAnchors[1], "another program")],
  ]) {
    assert.throws(
      () => buildReviewedFabrikaProgramEnrichmentPatch(
        night,
        { ...primary, ...primaryChange },
        { ...direct, ...directChange },
        persistedCaption,
      ),
      /Reviewed Fabrika/u,
    );
  }
}

console.log("QA passed: source-linked Fabrika updates require exact direct evidence, preserve event identity, and are idempotent.");
