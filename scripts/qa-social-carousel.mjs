import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import sharp from "sharp";
import {
  buildDailyCarouselPayload,
  EVENT_ZEKA_PUBLIC_ORIGIN,
  getNextIsoDate,
  normalizeInstagramHandle,
  selectDailyCarouselEvents,
} from "../lib/social/daily-carousel.ts";
import {
  renderCtaCarouselSlide,
  renderEventCarouselSlide,
} from "../lib/social/carousel-images.ts";

assert.equal(EVENT_ZEKA_PUBLIC_ORIGIN, "https://eventzeka.com");

const publishDate = "2026-07-19";
const eventDates = ["2026-07-20", "2026-07-21"];
const fixtures = [
  { _id: "event-a", title: "Noć u gradu", venue: "Venue A", date: eventDates[0], time: "21:00", venueInstagramHandle: "venue.a" },
  { _id: "event-b", title: "Koncert B", venue: "Venue B", date: eventDates[0], time: "TBD", venueInstagramHandle: "venue_b" },
  { _id: "event-c", title: "Izložba C", venue: "Venue C", date: eventDates[0], venueInstagramHandle: "venue.c" },
  { _id: "event-d", title: "Predstava D", venue: "Venue D", date: eventDates[1], venueInstagramHandle: "venue_d" },
  { _id: "event-e", title: "DJ veče E", venue: "Venue E", date: eventDates[1], venueInstagramHandle: "venue.e" },
  { _id: "event-f", title: "Festival F", venue: "Venue F", date: eventDates[1], venueInstagramHandle: "venue_f" },
  { _id: "event-g", title: "Drugi događaj istog mesta", venue: "Venue A", date: eventDates[1], venueInstagramHandle: "VENUE.A" },
  { _id: "event-h", title: "Bez Instagram naloga", venue: "Venue H", date: eventDates[0] },
  { _id: "event-i", title: "Danas se ne bira", venue: "Venue I", date: publishDate, venueInstagramHandle: "venue_i" },
  { _id: "event-j", title: "Tri dana unapred se ne bira", venue: "Venue J", date: "2026-07-22", venueInstagramHandle: "venue_j" },
  { _id: "event-k", title: "Nevažeći nalog", venue: "Venue K", date: eventDates[0], venueInstagramHandle: "bad handle/@victim" },
];

assert.equal(getNextIsoDate("2026-07-19"), "2026-07-20");
assert.throws(() => getNextIsoDate("not-a-date"), /Invalid carousel date/);
assert.throws(() => getNextIsoDate("2026-02-29"), /Invalid carousel date/);
assert.equal(normalizeInstagramHandle("@Venue.Name"), "venue.name");
assert.equal(normalizeInstagramHandle("bad handle/@victim"), "");
assert.equal(normalizeInstagramHandle("venue..name"), "");
assert.equal(normalizeInstagramHandle("venue."), "");

const selected = selectDailyCarouselEvents(fixtures, publishDate, 6, eventDates);
assert.equal(selected.length, 6);
assert.equal(new Set(selected.map((event) => event.venueInstagramHandle)).size, 6);
assert.deepEqual(selected, selectDailyCarouselEvents(fixtures, publishDate, 6, eventDates));
assert.ok(selected.every((event) => eventDates.includes(event.date) && event.venueInstagramHandle));
assert.deepEqual(new Set(selected.map((event) => event.date)), new Set(eventDates));
for (const date of eventDates) {
  assert.equal(selected.filter((event) => event.date === date).length, 3);
}

const payload = buildDailyCarouselPayload({
  events: fixtures,
  publishDate,
  eventDates,
  publicOrigin: "https://events.example.test",
});
assert.equal(payload.selectedCount, 6);
assert.deepEqual(payload.eventDates, eventDates);
assert.equal(payload.slides.length, 7);
assert.equal(payload.slides.at(-1)?.kind, "cta");
assert.match(payload.slides.at(-1)?.imageUrl ?? "", /\/api\/social\/carousel\/cta\?v=2$/);
assert.ok(payload.selectionKey.startsWith(`${publishDate}:${eventDates.join("+")}:`));
assert.match(payload.selectionKey, /event-[a-f]@[a-z0-9]+/);
assert.match(payload.caption, /plan za sutra i prekosutra/);
assert.match(payload.caption, /SUTRA/);
assert.match(payload.caption, /PREKOSUTRA/);
assert.match(payload.caption, /events\.example\.test/);
assert.doesNotMatch(payload.caption, /TBD —/);
assert.ok(payload.caption.length <= 2_200);
for (const event of selected) {
  assert.match(payload.caption, new RegExp(`@${event.venueInstagramHandle.replace(".", "\\.")}`));
}
for (const slide of payload.slides.filter((candidate) => candidate.kind === "event")) {
  assert.equal(slide.userTags?.length, 1);
  assert.equal(slide.userTags?.[0]?.username, slide.username);
  assert.match(slide.imageUrl, /\?v=[a-z0-9]+$/);
}

const hostilePayload = buildDailyCarouselPayload({
  events: [
    { _id: "hostile", title: "@victim #spam\u0000 " + "x".repeat(1_000), venue: "Venue", date: eventDates[0], time: "9".repeat(3_000), venueInstagramHandle: "safe_venue" },
  ],
  publishDate,
  eventDates,
  publicOrigin: "https://events.example.test",
});
assert.ok(hostilePayload.caption.length <= 2_200);
assert.doesNotMatch(hostilePayload.caption, /@victim|#spam|\u0000/);
assert.doesNotMatch(hostilePayload.caption, /9{20}/);

const emptyPayload = buildDailyCarouselPayload({
  events: [],
  publishDate,
  eventDates,
  publicOrigin: "https://events.example.test",
});
assert.equal(emptyPayload.selectedCount, 0);
assert.deepEqual(emptyPayload.eventDates, eventDates);
assert.deepEqual(emptyPayload.slides, []);
assert.equal(emptyPayload.caption, "");

const eventImage = await renderEventCarouselSlide({
  title: "Šta se dešava večeras?\u0000",
  venue: "Kulturni centar Beograda",
  instagramHandle: "kcb_beograd",
  date: eventDates[0],
  time: "20:30",
});
const eventMetadata = await sharp(eventImage).metadata();
assert.equal(eventMetadata.width, 1080);
assert.equal(eventMetadata.height, 1350);
assert.equal(eventMetadata.format, "jpeg");

const longTimeImage = await renderEventCarouselSlide({
  title: "Događaj sa dugim vremenskim opsegom",
  venue: "Beograd",
  instagramHandle: "eventzeka",
  date: eventDates[1],
  time: "18:00-00:00",
});
const longTimeMetadata = await sharp(longTimeImage).metadata();
assert.equal(longTimeMetadata.width, 1080);
assert.equal(longTimeMetadata.height, 1350);
assert.equal(longTimeMetadata.format, "jpeg");

const ctaImage = await renderCtaCarouselSlide();
const ctaMetadata = await sharp(ctaImage).metadata();
assert.equal(ctaMetadata.width, 1080);
assert.equal(ctaMetadata.height, 1350);
assert.equal(ctaMetadata.format, "jpeg");

const payloadRouteSource = readFileSync(
  new URL("../app/api/social/daily-carousel/route.ts", import.meta.url),
  "utf8",
);
const eventRouteSource = readFileSync(
  new URL("../app/api/social/carousel/events/[eventId]/route.ts", import.meta.url),
  "utf8",
);
const ctaRouteSource = readFileSync(
  new URL("../app/api/social/carousel/cta/route.ts", import.meta.url),
  "utf8",
);
const imageRendererSource = readFileSync(
  new URL("../lib/social/carousel-images.ts", import.meta.url),
  "utf8",
);
const workflow = JSON.parse(
  readFileSync(new URL("../ops/n8n/event-zeka-daily-instagram-carousel.json", import.meta.url), "utf8"),
)[0];
const workflowCode = workflow.nodes.find((node) => node.type === "n8n-nodes-base.code")?.parameters?.jsCode ?? "";
const scheduleNode = workflow.nodes.find((node) => node.type === "n8n-nodes-base.scheduleTrigger");

assert.match(payloadRouteSource, /isAuthorizedCronRequestHeader/);
assert.match(payloadRouteSource, /listPublicCalendarEventsWindow/);
assert.match(payloadRouteSource, /dayAfterTomorrow/);
assert.match(payloadRouteSource, /fromDate: tomorrow/);
assert.match(payloadRouteSource, /getPublicOrigin/);
assert.match(payloadRouteSource, /EVENT_ZEKA_PUBLIC_ORIGIN/);
assert.doesNotMatch(payloadRouteSource, /hasUsablePoster|selectPosterReadyEvents|\/api\/discover\/images/);
assert.match(eventRouteSource, /getPublicApprovedEvent/);
assert.match(eventRouteSource, /renderEventCarouselSlide/);
assert.doesNotMatch(eventRouteSource, /fetch\(|MAX_POSTER_BYTES|\/api\/discover\/images/);
assert.match(eventRouteSource, /"content-type": "image\/jpeg"/);
assert.match(ctaRouteSource, /"content-type": "image\/jpeg"/);
assert.match(imageRendererSource, /limitInputPixels: 2_000_000/);
assert.match(imageRendererSource, /\.jpeg\(/);
assert.match(imageRendererSource, /datePillWidth/);
assert.match(imageRendererSource, />eventzeka\.com<\/text>/);
assert.doesNotMatch(imageRendererSource, />events\.ineedtofeedmyrabbit\.com<\/text>/);
assert.equal(scheduleNode?.parameters?.rule?.interval?.[0]?.expression, "1 0 * * *");
assert.match(workflowCode, /this\.helpers\.httpRequest/);
assert.doesNotMatch(workflowCode, /await fetch\(/);
assert.match(workflowCode, /is_carousel_item/);
assert.match(workflowCode, /user_tags/);
assert.match(workflowCode, /media_type: 'CAROUSEL'/);
assert.match(workflowCode, /children: childIds\.join/);
assert.match(workflowCode, /media_publish/);
assert.match(workflowCode, /maxAttempts: 1/);
assert.match(workflowCode, /blocked_reconciliation_required/);
assert.match(workflowCode, /pendingSelectionKey/);

console.log("Daily Instagram carousel QA passed: deterministic two-day selection, validated tags/caption, n8n HTTP helper, and Graph-compatible 1080x1350 JPEG rendering.");
