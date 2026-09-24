import assert from "node:assert/strict";
import {
  buildReviewedFabrikaDjNightEnrichmentPatch,
  FABRIKA_DJ_NIGHT_DESCRIPTION,
  FABRIKA_DJ_NIGHT_DIRECT_ID,
  FABRIKA_DJ_NIGHT_DIRECT_URL,
  FABRIKA_DJ_NIGHT_PRIMARY_ID,
  FABRIKA_DJ_NIGHT_TICKET_PRICE,
  FABRIKA_DJ_NIGHT_WEEKLY_URL,
} from "../lib/events/reviewed-fabrika-dj-night-enrichment.ts";

const caption = [
  "Najjači dan nedelje - četvrtak posvećen je DJevima.",
  "@insta_slinksta",
  "@seratlicp",
  "@pedja_skakavac",
  "četvrtak 24.09. | 21:00 | 🎟️: 500 rsd",
  "🪩 DJ Night - dub, reggae, ska, raga, dnb",
  "📍Radnička 5N, Ada Ciganlija",
].join("\n");
const primary = {
  _id: FABRIKA_DJ_NIGHT_PRIMARY_ID,
  status: "approved",
  title: "DJ NIGHT",
  date: "2026-09-24",
  time: "21:00-01:00",
  venue: "Fabrika Alternativne Kulturne Scene",
  venueId: "fabrika-venue",
  venueInstagramHandle: "faks_beograd",
  artists: [],
  eventType: "nightlife",
  instagramPostUrl: FABRIKA_DJ_NIGHT_WEEKLY_URL,
};
const direct = {
  _id: FABRIKA_DJ_NIGHT_DIRECT_ID,
  status: "pending",
  title: "Insta Slinksta, Seratlicp, Pedja Skakavac",
  date: "2026-09-24",
  time: "21:00",
  venue: "Fabrika Alternativne Kulturne Scene",
  venueId: "fabrika-venue",
  venueInstagramHandle: "faks_beograd",
  artists: ["@insta_slinksta", "@seratlicp", "@pedja_skakavac"],
  eventType: "nightlife",
  instagramPostUrl: FABRIKA_DJ_NIGHT_DIRECT_URL,
  sourceCaption: caption,
  ticketPrice: "500 rsd",
};

const patch = buildReviewedFabrikaDjNightEnrichmentPatch(primary, direct, caption);
assert.deepEqual(patch, {
  description: FABRIKA_DJ_NIGHT_DESCRIPTION,
  ticketPrice: FABRIKA_DJ_NIGHT_TICKET_PRICE,
  alreadyDone: false,
});
assert.equal(
  buildReviewedFabrikaDjNightEnrichmentPatch(
    { ...primary, description: patch.description, ticketPrice: patch.ticketPrice },
    direct,
    caption,
  ).alreadyDone,
  true,
);

for (const [primaryChange, directChange, postCaption] of [
  [{ status: "pending" }, {}, caption],
  [{ title: "Other event" }, {}, caption],
  [{ time: "20:00-01:00" }, {}, caption],
  [{ venueId: "other-venue" }, {}, caption],
  [{ instagramPostUrl: FABRIKA_DJ_NIGHT_DIRECT_URL }, {}, caption],
  [{ description: "Unreviewed copy" }, {}, caption],
  [{ ticketPrice: "Free" }, {}, caption],
  [{}, { status: "approved" }, caption],
  [{}, { date: "2026-09-25" }, caption],
  [{}, { time: "22:00" }, caption],
  [{}, { artists: ["@other_artist"] }, caption],
  [{}, { ticketPrice: "free" }, caption],
  [{}, { sourceCaption: caption.replace("500 rsd", "free") }, caption],
  [{}, {}, caption.replace("@seratlicp", "@someone_else")],
]) {
  assert.throws(
    () => buildReviewedFabrikaDjNightEnrichmentPatch(
      { ...primary, ...primaryChange },
      { ...direct, ...directChange },
      postCaption,
    ),
    /Reviewed Fabrika DJ Night/u,
  );
}
console.log("QA passed: exact Fabrika DJ Night evidence and idempotent public enrichment.");
