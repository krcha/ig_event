import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import sharp from "sharp";
import {
  buildDailyCarouselPayload,
  getNextIsoDate,
  selectDailyCarouselEvents,
} from "../lib/social/daily-carousel.ts";
import {
  renderCtaCarouselSlide,
  renderEventCarouselSlide,
} from "../lib/social/carousel-images.ts";

const publishDate = "2026-07-19";
const fixtures = [
  { _id: "event-a", title: "Noć u gradu", venue: "Venue A", date: publishDate, time: "21:00", venueInstagramHandle: "venue.a" },
  { _id: "event-b", title: "Koncert B", venue: "Venue B", date: publishDate, time: "TBD", venueInstagramHandle: "venue_b" },
  { _id: "event-c", title: "Izložba C", venue: "Venue C", date: publishDate, venueInstagramHandle: "venue.c" },
  { _id: "event-d", title: "Predstava D", venue: "Venue D", date: publishDate, venueInstagramHandle: "venue_d" },
  { _id: "event-e", title: "DJ veče E", venue: "Venue E", date: publishDate, venueInstagramHandle: "venue.e" },
  { _id: "event-f", title: "Festival F", venue: "Venue F", date: publishDate, venueInstagramHandle: "venue_f" },
  { _id: "event-g", title: "Drugi događaj istog mesta", venue: "Venue A", date: publishDate, venueInstagramHandle: "VENUE.A" },
  { _id: "event-h", title: "Bez Instagram naloga", venue: "Venue H", date: publishDate },
  { _id: "event-i", title: "Sutra", venue: "Venue I", date: "2026-07-20", venueInstagramHandle: "venue_i" },
];

assert.equal(getNextIsoDate("2026-07-19"), "2026-07-20");
assert.throws(() => getNextIsoDate("not-a-date"), /Invalid carousel date/);

const selected = selectDailyCarouselEvents(fixtures, publishDate);
assert.equal(selected.length, 6);
assert.equal(new Set(selected.map((event) => event.venueInstagramHandle)).size, 6);
assert.deepEqual(selected, selectDailyCarouselEvents(fixtures, publishDate));
assert.ok(selected.every((event) => event.date === publishDate && event.venueInstagramHandle));

const payload = buildDailyCarouselPayload({
  events: fixtures,
  publishDate,
  publicOrigin: "https://events.example.test",
});
assert.equal(payload.selectedCount, 6);
assert.equal(payload.slides.length, 7);
assert.equal(payload.slides.at(-1)?.kind, "cta");
assert.match(payload.slides.at(-1)?.imageUrl ?? "", /\/api\/social\/carousel\/cta$/);
assert.ok(payload.selectionKey.startsWith(`${publishDate}:`));
assert.match(payload.caption, /Beograde, gde ćemo danas/);
assert.match(payload.caption, /events\.example\.test/);
assert.doesNotMatch(payload.caption, /TBD —/);
for (const event of selected) {
  assert.match(payload.caption, new RegExp(`@${event.venueInstagramHandle.replace(".", "\\.")}`));
}
for (const slide of payload.slides.filter((candidate) => candidate.kind === "event")) {
  assert.equal(slide.userTags?.length, 1);
  assert.equal(slide.userTags?.[0]?.username, slide.username);
}

const emptyPayload = buildDailyCarouselPayload({
  events: [],
  publishDate,
  publicOrigin: "https://events.example.test",
});
assert.equal(emptyPayload.selectedCount, 0);
assert.deepEqual(emptyPayload.slides, []);
assert.equal(emptyPayload.caption, "");

const poster = await sharp({
  create: {
    width: 900,
    height: 1200,
    channels: 4,
    background: { r: 72, g: 40, b: 120, alpha: 1 },
  },
})
  .png()
  .toBuffer();
const eventImage = await renderEventCarouselSlide({
  poster,
  title: "Šta se dešava večeras?",
  venue: "Kulturni centar Beograda",
  instagramHandle: "kcb_beograd",
  date: publishDate,
  time: "20:30",
});
const eventMetadata = await sharp(eventImage).metadata();
assert.equal(eventMetadata.width, 1080);
assert.equal(eventMetadata.height, 1350);
assert.equal(eventMetadata.format, "png");

const ctaImage = await renderCtaCarouselSlide();
const ctaMetadata = await sharp(ctaImage).metadata();
assert.equal(ctaMetadata.width, 1080);
assert.equal(ctaMetadata.height, 1350);
assert.equal(ctaMetadata.format, "png");

const payloadRouteSource = readFileSync(
  new URL("../app/api/social/daily-carousel/route.ts", import.meta.url),
  "utf8",
);
const eventRouteSource = readFileSync(
  new URL("../app/api/social/carousel/events/[eventId]/route.ts", import.meta.url),
  "utf8",
);
assert.match(payloadRouteSource, /isAuthorizedCronRequestHeader/);
assert.match(payloadRouteSource, /listPublicCalendarEventsWindow/);
assert.match(eventRouteSource, /getPublicApprovedEvent/);
assert.match(eventRouteSource, /renderEventCarouselSlide/);

console.log("Daily Instagram carousel QA passed: deterministic six-venue selection, tags, caption, auth, and 1080x1350 PNG rendering.");
