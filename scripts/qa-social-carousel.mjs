import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import sharp from "sharp";
import { ConvexHttpClient } from "convex/browser";
import { GET as getAgendaPoster } from "../app/api/social/carousel/days/[date]/route.ts";
import {
  buildAgendaRenderVersion,
  buildDailyCarouselCaption,
  buildDailyCarouselPayload,
  buildEventRenderVersion,
  EVENT_ZEKA_PUBLIC_ORIGIN,
  formatAgendaDate,
  getAgendaEventDetail,
  getAgendaEventTime,
  getBelgradeDate,
  getNextIsoDate,
  getUpcomingAgendaDates,
  normalizeInstagramHandle,
  selectDailyCarouselEvents,
} from "../lib/social/daily-carousel.ts";
import { getAgendaTagPositions } from "../lib/social/agenda-layout.ts";
import {
  buildAgendaPosterSvg,
  renderAgendaPoster,
} from "../lib/social/agenda-images.ts";
import {
  renderCtaCarouselSlide,
  renderEventCarouselSlide,
} from "../lib/social/carousel-images.ts";

const publishDate = "2026-10-13";
const eventDates = ["2026-10-14", "2026-10-15", "2026-10-16"];
const fixtures = eventDates.flatMap((date, day) => Array.from({ length: 5 }, (_, index) => ({
  _id: `event-${day}-${index}`,
  title: `Program ${day} ${index}`,
  venue: `Prostor ${index}`,
  date,
  time: index === 4 ? "TBD" : `${19 + index}:00`,
  timeSource: index === 4 ? "unknown" : "caption",
  timeStatus: index === 4 ? "unknown" : "confirmed",
  artists: [],
  eventType: index === 1 ? "live music" : "nightlife",
  ticketPrice: index === 1 ? "Preporučeni prilog 500 RSD" : undefined,
  venueInstagramHandle: index === 0 ? undefined : index === 2 ? "bad handle/@victim" : `venue.${index}`,
})));

assert.equal(EVENT_ZEKA_PUBLIC_ORIGIN, "https://eventzeka.com");
assert.deepEqual(getUpcomingAgendaDates(publishDate), eventDates);
assert.deepEqual(getUpcomingAgendaDates("2026-12-30"), ["2026-12-31", "2027-01-01", "2027-01-02"]);
assert.equal(getBelgradeDate(new Date("2026-10-13T22:01:00Z")), "2026-10-14");
assert.equal(getNextIsoDate("2028-02-28"), "2028-02-29");
assert.throws(() => getNextIsoDate("not-a-date"), /Invalid carousel date/);
assert.throws(() => getNextIsoDate("2026-02-29"), /Invalid carousel date/);
assert.deepEqual(formatAgendaDate(eventDates[0]), { weekday: "Sreda", dateLabel: "14. oktobra 2026." });
assert.equal(formatAgendaDate("2027-01-01").dateLabel, "1. januara 2027.");
assert.equal(normalizeInstagramHandle("@Venue.Name"), "venue.name");
for (const invalid of ["bad handle/@victim", "venue..name", "venue.", "x".repeat(31)]) assert.equal(normalizeInstagramHandle(invalid), "");

const selected = selectDailyCarouselEvents(fixtures, publishDate);
assert.equal(selected.length, 9);
for (const date of eventDates) {
  const day = selected.filter((event) => event.date === date);
  assert.equal(day.length, 3);
  assert.equal(new Set(day.map((event) => event.venue)).size, 3);
  assert.ok(day.every((event) => event.time !== "TBD"), "announced times are preferred when enough events have them");
}
assert.ok(new Set(selected.map((event) => event.venue)).size < selected.length, "the same venue may appear on different dates");
assert.deepEqual(selected, selectDailyCarouselEvents([...fixtures].reverse(), publishDate), "source order does not reroll the selection");
const followingSelection = selectDailyCarouselEvents(fixtures, eventDates[0]);
for (const date of eventDates.slice(1)) {
  assert.deepEqual(selected.filter((event) => event.date === date), followingSelection.filter((event) => event.date === date), "overlapping days keep their ordered event selection");
}
assert.deepEqual(selectDailyCarouselEvents([...fixtures, fixtures[0]], publishDate), selected, "duplicate source rows do not consume a slot");

const optionalHandles = fixtures.filter((event) => event.date === eventDates[0] && ["event-0-0", "event-0-1", "event-0-2"].includes(event._id));
const optionalPayload = buildDailyCarouselPayload({ events: optionalHandles, publishDate, publicOrigin: EVENT_ZEKA_PUBLIC_ORIGIN });
assert.equal(optionalPayload.selectedCount, 3, "missing or invalid Instagram handles do not hide approved events");
assert.equal(optionalPayload.slides[0].userTags.length, 1);
assert.equal(optionalPayload.slides[0].userTags[0].username, "venue.1");
const sharedVenue = optionalHandles.map((event) => ({ ...event, venue: "Jedan prostor", venueInstagramHandle: "one.venue" }));
const sharedPayload = buildDailyCarouselPayload({ events: sharedVenue, publishDate, publicOrigin: EVENT_ZEKA_PUBLIC_ORIGIN });
assert.equal(sharedPayload.selectedCount, 3, "a sparse day can contain multiple real events at the same venue");
assert.equal(sharedPayload.slides[0].userTags.length, 1, "Instagram user tags are unique per image");

const payload = buildDailyCarouselPayload({ events: fixtures, publishDate, publicOrigin: "https://events.example.test/" });
assert.equal(payload.selectedCount, 9);
assert.deepEqual(payload.eventDates, eventDates);
assert.equal(payload.slides.length, 3);
assert.ok(payload.slides.every((slide) => slide.kind === "agenda"));
assert.ok(payload.selectionKey.startsWith(`${publishDate}:`));
assert.match(payload.caption, /Sreda, 14\. oktobra 2026\./);
assert.match(payload.caption, /Četvrtak, 15\. oktobra 2026\./);
assert.match(payload.caption, /Petak, 16\. oktobra 2026\./);
assert.match(payload.caption, /Detalji događaja: events\.example\.test$/);
assert.doesNotMatch(payload.caption, /Zeka zna|ne propust|najbolji provod|nezaboravn|SUTRA|PREKOSUTRA|#|🐇|💜/i);
assert.ok(payload.caption.length <= 2_200);
for (const event of selected) {
  assert.ok(payload.caption.includes(event.title));
  assert.ok(payload.caption.includes(event.venue));
}
for (const [position, slide] of payload.slides.entries()) {
  assert.equal(slide.position, position);
  assert.equal(slide.eventIds.length, 3);
  assert.equal(slide.date, eventDates[position]);
  const imageUrl = new URL(slide.imageUrl);
  const events = selected.filter((event) => event.date === slide.date);
  assert.equal(imageUrl.pathname, `/api/social/carousel/days/${slide.date}`);
  assert.equal(imageUrl.searchParams.get("events"), slide.eventIds.join(","));
  assert.equal(imageUrl.searchParams.get("position"), String(position));
  assert.equal(imageUrl.searchParams.get("v"), buildAgendaRenderVersion(slide.date, events, position));
  const positions = getAgendaTagPositions(events.map((event) => ({ title: event.title, venue: event.venue, time: getAgendaEventTime(event), detail: getAgendaEventDetail(event) })));
  for (const tag of slide.userTags) {
    const index = events.findIndex((event) => normalizeInstagramHandle(event.venueInstagramHandle) === tag.username);
    assert.deepEqual({ x: tag.x, y: tag.y }, positions[index]);
    assert.ok(tag.x >= 0 && tag.x <= 1 && tag.y >= 0 && tag.y <= 1);
  }
}

const metadataEvent = { ...fixtures[0], title: "Veče u studiju", artists: ["Bend A"], ticketPrice: "Preporučeni prilog 500 RSD" };
assert.match(getAgendaEventDetail(metadataEvent), /Preporučeni prilog 500 RSD/);
assert.doesNotMatch(getAgendaEventDetail(metadataEvent), /Ulaz 500/);
const fullArtistName = "Ansambl za savremenu muziku Kulturnog centra Beograda";
assert.equal(getAgendaEventDetail({ ...metadataEvent, artists: [fullArtistName], ticketPrice: undefined }), fullArtistName, "artist identities are never abbreviated");
assert.equal(getAgendaEventDetail({ ...metadataEvent, artists: ["Bend A", "Bend B", "Bend C", "Bend D"], ticketPrice: undefined }), "Bend A, Bend B, Bend C, Bend D", "a complete short lineup includes every artist");
assert.equal(getAgendaEventDetail({ ...metadataEvent, artists: [fullArtistName, fullArtistName + " drugi sastav"], ticketPrice: undefined }), "", "an oversized optional lineup is omitted instead of clipping artist names");
assert.equal(getAgendaEventDetail({ ...metadataEvent, artists: [], eventType: "event", ticketPrice: "free" }), "Slobodan ulaz");
const donationEvent = { ...metadataEvent, artists: [], eventType: "live music", ticketPrice: "Suggested donation: 1,000 RSD for lecture and party; 300 RSD for party" };
const translatedDonation = "Preporučeni prilog: 1,000 RSD za predavanje i žurku; 300 RSD za žurku";
assert.equal(getAgendaEventDetail(donationEvent), translatedDonation, "donation amounts and separate admission conditions survive exact phrase translation");
assert.ok(buildDailyCarouselCaption([donationEvent], EVENT_ZEKA_PUBLIC_ORIGIN).includes(translatedDonation));
assert.equal(getAgendaEventDetail({ ...donationEvent, ticketPrice: "unsuggested donations for partygoers" }), "unsuggested donations for partygoers", "phrase translation respects word boundaries");
assert.equal(getAgendaEventDetail({ ...donationEvent, ticketPrice: undefined }), "", "generic event types do not add repetitive filler");
assert.equal(getAgendaEventDetail({ ...metadataEvent, artists: ["C\u030cudesni bend"], ticketPrice: undefined }), "Čudesni bend", "Serbian artist text is normalized to NFC");
assert.equal(getAgendaEventTime({ ...metadataEvent, time: "18:00-00:00" }), "18:00–00:00");
assert.equal(getAgendaEventTime({ ...metadataEvent, time: "99:99" }), "");
assert.equal(getAgendaEventTime({ ...metadataEvent, timeStatus: "inferred" }), "");
assert.equal(getAgendaEventTime({ ...metadataEvent, timeSource: "model" }), "");
const originalVersion = buildAgendaRenderVersion(metadataEvent.date, [metadataEvent], 0);
for (const change of [{ title: "Drugi program" }, { venue: "Drugi prostor" }, { time: "23:30" }, { artists: ["Bend B"] }, { ticketPrice: "600 RSD" }, { venueInstagramHandle: "new.venue" }]) {
  assert.notEqual(originalVersion, buildAgendaRenderVersion(metadataEvent.date, [{ ...metadataEvent, ...change }], 0), "changed displayed facts invalidate image URLs");
}
assert.notEqual(originalVersion, buildAgendaRenderVersion(metadataEvent.date, [metadataEvent], 1), "the poster palette/index is versioned");
const formatOnly = { ...metadataEvent, artists: [], ticketPrice: undefined, eventType: "event" };
assert.equal(buildAgendaRenderVersion(formatOnly.date, [formatOnly], 0), buildAgendaRenderVersion(formatOnly.date, [{ ...formatOnly, eventType: "live music" }], 0), "unused generic categories do not change rendered facts");
assert.equal(originalVersion, buildAgendaRenderVersion(metadataEvent.date, [{ ...metadataEvent, description: "not present in the calendar projection" }], 0), "calendar and approved-event detail projections produce the same image version");
assert.equal(buildEventRenderVersion(metadataEvent), buildEventRenderVersion({ ...metadataEvent, artists: ["Legacy helper ignores added metadata"] }), "legacy single-event URLs remain compatible");

const hostileEvents = [{ _id: "hostile", title: "@victim #spam\u0000\u202E " + "x".repeat(1_000), venue: "Mesto\u0000 " + "v".repeat(1_000), date: eventDates[0], time: "9".repeat(3_000), artists: ["@victim #spam " + "a".repeat(1_000)], ticketPrice: "p".repeat(1_000), venueInstagramHandle: "safe_venue" }];
const hostileCaption = buildDailyCarouselCaption(hostileEvents, "https://events.example.test", eventDates);
assert.ok(hostileCaption.length <= 2_200);
assert.doesNotMatch(hostileCaption, /@victim|#spam|\u0000|\u202E|9{20}/);
assert.throws(() => buildDailyCarouselPayload({ events: hostileEvents, publishDate, publicOrigin: EVENT_ZEKA_PUBLIC_ORIGIN }), /safe poster layout limit/, "unrenderable identities fail before publishing");
const maxLengthCaption = buildDailyCarouselCaption(selected.map((event) => ({ ...event, title: "t".repeat(1_000), venue: `Prostor ${event._id} ` + "v".repeat(1_000), artists: ["a".repeat(1_000)], ticketPrice: "Preporučeni prilog 500 RSD" })), EVENT_ZEKA_PUBLIC_ORIGIN, eventDates);
assert.ok(maxLengthCaption.length <= 2_200);
assert.match(maxLengthCaption, /Detalji događaja: eventzeka\.com$/);
assert.match(maxLengthCaption, /Preporučeni prilog 500 RSD/);
const maximumPriceCondition = "Preporučeni prilog 500 RSD; dobrovoljno učešće, rezervacija nije obavezna.".padEnd(80, ".");
const maximumCaptionEvents = selected.map((event, index) => ({ ...event,
  title: `Događaj ${index} `.padEnd(85, "t"),
  venue: `Prostor ${index} `.padEnd(50, "v"),
  time: "18:00-00:00", timeSource: "caption", timeStatus: "confirmed",
  artists: [], eventType: "nightlife", ticketPrice: maximumPriceCondition,
}));
const budgetedCaption = buildDailyCarouselCaption(maximumCaptionEvents, EVENT_ZEKA_PUBLIC_ORIGIN, eventDates);
assert.ok(budgetedCaption.length <= 2_200);
assert.match(budgetedCaption, /Detalji događaja: eventzeka\.com$/);
for (const event of maximumCaptionEvents) {
  assert.ok(budgetedCaption.includes(event.title), "all nine complete caption titles survive budgeting");
  assert.ok(budgetedCaption.includes(event.venue), "all nine complete caption venues survive budgeting");
}
const captionPriceLines = budgetedCaption.split("\n").filter((line) => line.includes("Preporučeni prilog"));
assert.ok(captionPriceLines.length > 0 && captionPriceLines.length < 9, "the maximum-length fixture requires dropping optional detail");
assert.ok(captionPriceLines.every((line) => line.endsWith(maximumPriceCondition)), "remaining price conditions are whole");
const emptyPayload = buildDailyCarouselPayload({ events: [], publishDate, publicOrigin: EVENT_ZEKA_PUBLIC_ORIGIN });
assert.equal(emptyPayload.selectedCount, 0);
assert.deepEqual(emptyPayload.slides, []);
assert.equal(emptyPayload.caption, "");

for (const [position, date] of eventDates.entries()) {
  const input = { date, position, events: selected.filter((event) => event.date === date) };
  const poster = await renderAgendaPoster(input);
  const metadata = await sharp(poster).metadata();
  assert.deepEqual([metadata.width, metadata.height, metadata.format], [1080, 1350, "jpeg"]);
  const svg = buildAgendaPosterSvg(input).toString("utf8");
  assert.doesNotMatch(svg, /🐇|Zeka zna|linearGradient/);
}
const longTitlePoster = await renderAgendaPoster({ date: eventDates[0], position: 0, events: [{ ...metadataEvent, title: "Predavanje i razgovor: kako grad menja naš svakodnevni život i gde se sreću muzika, umetnost i javni prostor" }, { ...metadataEvent, _id: "long-2", title: "Muzički program: pesme Dejvida Bouvija, koncert i razgovor sa publikom" }, { ...metadataEvent, _id: "long-3", title: "KRATKO", time: "TBD" }] });
assert.equal((await sharp(longTitlePoster).metadata()).height, 1350);
for (const legacyImage of [await renderEventCarouselSlide({ title: "Šta se dešava večeras?\u0000", venue: "Kulturni centar Beograda", instagramHandle: "kcb_beograd", date: eventDates[0], time: "20:30" }), await renderCtaCarouselSlide()]) {
  const metadata = await sharp(legacyImage).metadata();
  assert.deepEqual([metadata.width, metadata.height, metadata.format], [1080, 1350, "jpeg"]);
}

const originalQuery = ConvexHttpClient.prototype.query;
const originalConvexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
const routeEvent = { ...metadataEvent, _id: "qaagenda00001", status: "approved" };
const routeRecords = new Map([[routeEvent._id, routeEvent]]);
let queryCount = 0;
const routeVersion = buildAgendaRenderVersion(routeEvent.date, [routeEvent], 0);
async function requestPoster({ date = routeEvent.date, events = routeEvent._id, position = "0", version = routeVersion, extra = "" } = {}) {
  const parameters = new URLSearchParams({ events, position, v: version });
  return await getAgendaPoster(new Request(`https://events.example.test/api/social/carousel/days/${date}?${parameters}${extra}`), { params: Promise.resolve({ date }) });
}
try {
  process.env.NEXT_PUBLIC_CONVEX_URL = "https://qa-agenda.convex.cloud";
  ConvexHttpClient.prototype.query = async (_reference, args) => {
    queryCount += 1;
    return routeRecords.get(args.id) ?? null;
  };
  for (const invalid of [{ date: "2026-02-29" }, { events: "short" }, { events: "qaagenda00001,qaagenda00002,qaagenda00003,qaagenda00004" }, { events: "qaagenda00001,qaagenda00001" }, { position: "3" }, { version: "" }, { extra: "&events=qaagenda00002" }]) {
    assert.equal((await requestPoster(invalid)).status, 400);
  }
  assert.equal(queryCount, 0, "malformed image requests never reach the data API");
  const response = await requestPoster();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/jpeg");
  assert.equal(response.headers.get("cache-control"), "public, max-age=60, must-revalidate");
  assert.deepEqual([(await sharp(Buffer.from(await response.arrayBuffer())).metadata()).width, response.headers.get("x-content-type-options")], [1080, "nosniff"]);
  routeRecords.clear();
  assert.equal((await requestPoster()).status, 404, "withdrawn events cannot be rendered from old public URLs");
  routeRecords.set(routeEvent._id, { ...routeEvent, date: eventDates[1] });
  assert.equal((await requestPoster()).status, 404, "each selected event must still belong to the exact poster day");
  routeRecords.set(routeEvent._id, { ...routeEvent, title: "Changed approved event" });
  assert.equal((await requestPoster()).status, 409, "changed event facts require a refreshed payload/version");
  const oversizedEvent = { ...routeEvent, title: "x".repeat(1_000) };
  routeRecords.set(routeEvent._id, oversizedEvent);
  assert.equal((await requestPoster({ version: buildAgendaRenderVersion(oversizedEvent.date, [oversizedEvent], 0) })).status, 422, "unrenderable identities cannot produce a clipped public image");
  delete process.env.NEXT_PUBLIC_CONVEX_URL;
  assert.equal((await requestPoster()).status, 503, "missing runtime configuration fails closed");
} finally {
  ConvexHttpClient.prototype.query = originalQuery;
  if (originalConvexUrl === undefined) delete process.env.NEXT_PUBLIC_CONVEX_URL;
  else process.env.NEXT_PUBLIC_CONVEX_URL = originalConvexUrl;
}

const payloadRouteSource = readFileSync(new URL("../app/api/social/daily-carousel/route.ts", import.meta.url), "utf8");
const dayRouteSource = readFileSync(new URL("../app/api/social/carousel/days/[date]/route.ts", import.meta.url), "utf8");
assert.match(payloadRouteSource, /isAuthorizedCronRequestHeader/);
assert.match(payloadRouteSource, /listPublicCalendarEventsWindow/);
assert.match(payloadRouteSource, /fromDate: tomorrow/);
assert.match(payloadRouteSource, /beforeDate: getNextIsoDate\(thirdDay\)/);
assert.match(dayRouteSource, /getPublicApprovedEvent/);
assert.match(dayRouteSource, /buildAgendaRenderVersion/);
assert.match(dayRouteSource, /"content-type": "image\/jpeg"/);
const workflow = JSON.parse(readFileSync(new URL("../ops/n8n/event-zeka-daily-instagram-carousel.json", import.meta.url), "utf8"))[0];
const workflowCode = workflow.nodes.find((node) => node.type === "n8n-nodes-base.code")?.parameters?.jsCode ?? "";
const scheduleNode = workflow.nodes.find((node) => node.type === "n8n-nodes-base.scheduleTrigger");
assert.equal(scheduleNode?.parameters?.rule?.interval?.[0]?.expression, "30 16 * * *");
assert.equal(workflow.settings.timezone, "Europe/Belgrade");
assert.match(workflowCode, /this\.helpers\.httpRequest/);
assert.match(workflowCode, /user_tags/);
assert.match(workflowCode, /media_type: 'CAROUSEL'/);
assert.match(workflowCode, /media_publish/);
assert.match(workflowCode, /maxAttempts: 1/);
assert.match(workflowCode, /blocked_reconciliation_required/);
assert.match(workflowCode, /pendingSelectionKey/);
assert.doesNotMatch(workflowCode, /slide\.kind === 'event'/, "venue tags apply to agenda pages");

console.log("Daily Instagram agenda QA passed: three-day event quotas, stable overlap, optional valid tags at actual row positions, factual Serbian captions, metadata-versioned images, and 1080x1350 JPEG posters.");
