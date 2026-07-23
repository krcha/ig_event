import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  UNKNOWN_EVENT_TIME_LABEL,
  extractEventTimeEvidenceFromText,
  getEventTimeProvenanceLabel,
  resolveEventTimeDisplay,
} from "../lib/events/event-time.ts";
import { normalizeEventTimeWritePatch } from "../lib/events/event-time-write.ts";
import { getNightlifeDefaultDateKey } from "../lib/events/nightlife-date.ts";
import { buildDuplicateUpdatePatch } from "../lib/pipeline/run-instagram-ingestion.ts";

const exactEvidence = extractEventTimeEvidenceFromText("Poster line: POČETAK   21H tonight");
assert.deepEqual(exactEvidence, {
  evidence: "POČETAK   21H",
  time: "21:00",
});

for (const [text, expected] of [
  ["21H", "21:00"],
  ["21 h", "21:00"],
  ["21:00", "21:00"],
  ["Početak 21H", "21:00"],
  ["Start at 9", "09:00"],
  ["Doors open 8:30 pm", "20:30"],
  ["Music from 9 to 17", "09:00-17:00"],
  ["Event at 9", "09:00"],
  ["22h - 05h", "22:00-05:00"],
  ["Ulaz od 18 godina, početak u 21h", "21:00"],
  ["Popust 20% pre 22h, početak u 21h", "21:00"],
  ["Radno vreme do 17, koncert počinje u 21h", "21:00"],
  ["Ulaz od 18 godina a početak u 21h", "21:00"],
  ["Popust 20% pre 22h ali koncert počinje u 21h", "21:00"],
  ["Radno vreme do 17 a koncert počinje u 21h", "21:00"],
  ["Početak u 21h uz 20% popusta", "21:00"],
  ["Ulaz od 10 do 20 evra, početak u 21h", "21:00"],
  ["Tickets from 10 to 20 dollars but event starts at 21h", "21:00"],
  ["Open: 9h-17h, concert starts at 21h", "21:00"],
  ["Happy hour from 5 to 8 but show starts at 21h", "21:00"],
]) {
  assert.equal(extractEventTimeEvidenceFromText(text)?.time, expected, `time evidence: ${text}`);
}

for (const text of [
  "19.06",
  "11.06-17.06",
  "od 11. do 17. juna",
  "Karte od 1000 RSD",
  "Ulaz od 18+",
  "Ulaz od 18 godina",
  "Raspon od 10 do 20",
  "Popust od 10 do 20%",
  "Radno vreme: od 9 do 17",
  "Working hours from 9 to 17",
  "Open daily from 9 to 17",
  "Otvoreno od 9 do 17",
  "Lokal radi od 9 do 17",
  "Bar hours: 9h-17h",
  "Od 10 do 20 posto popusta",
  "We are open from 9 to 17",
  "Otvoreni smo od 9 do 17",
  "Lokal je otvoren od 9 do 17",
  "Bar is open from 9 to 17",
  "Od 10 do 20 procenata popusta",
  "Ulaz od 10 do 20 evra",
  "Cena od 10 do 20 eura",
  "Karte od 10 do 20 dolara",
  "Tickets from 10 to 20 dollars",
  "Entry from 10 to 20 euros",
  "Open: 9h-17h",
  "Hours: 9h-17h",
  "Happy hour from 5 to 8",
  "Happy hours: 5h-8h",
  "Adresa: Knez Mihailova 21",
  "Address: 21 Main Street",
  "Kapacitet 20 ljudi",
  "Capacity 21 people",
]) {
  assert.equal(extractEventTimeEvidenceFromText(text), undefined, `reject non-time: ${text}`);
}

const existingDuplicate = {
  _id: "event-1",
  title: "QA Event",
  date: "2026-07-15",
  time: "21:00",
  venue: "QA Venue",
  artists: ["QA Artist"],
  eventType: "nightlife",
  status: "pending",
};
const preparedDuplicate = {
  title: "QA Event",
  date: "2026-07-15",
  time: "21:00",
  timeSource: "caption",
  timeEvidenceText: "Početak 21H",
  timeConfidence: 0.95,
  timeStatus: "confirmed",
  venue: "QA Venue",
  artists: ["QA Artist"],
  imageUrl: "https://example.com/qa-event.jpg",
  sourceCaption: "QA Event 15. jul u 21h @ QA Venue uz QA Artist",
  instagramPostUrl: "https://www.instagram.com/p/qa-event/",
  instagramPostId: "qa-event",
  eventType: "nightlife",
  status: "pending",
};
const protectedApprovedDuplicate = buildDuplicateUpdatePatch(
  { ...existingDuplicate, status: "approved" },
  {
    ...preparedDuplicate,
    title: "MODEL-ONLY HALLUCINATION",
    normalizedFieldsJson: JSON.stringify({ sourceGroundingVerified: false }),
  },
);
assert.equal(protectedApprovedDuplicate.protectedApprovedFromPending, true);
assert.deepEqual(
  protectedApprovedDuplicate.patch,
  {},
  "A pending model-only duplicate must never overwrite an already public event.",
);
const staleApprovedDuplicate = buildDuplicateUpdatePatch(
  { ...existingDuplicate, status: "approved" },
  {
    ...preparedDuplicate,
    status: "approved",
    title: "STALE BOOLEAN BYPASS",
    normalizedFieldsJson: JSON.stringify({ sourceGroundingVerified: true }),
  },
);
assert.equal(
  staleApprovedDuplicate.protectedApprovedFromPending,
  true,
  "An approved label with incomplete grounding metadata must fail closed to pending.",
);
assert.deepEqual(staleApprovedDuplicate.patch, {});
const completeSourceGroundedApprovalJson = JSON.stringify({
  title: "QA Event",
  time: "21:00",
  artists: ["QA Artist"],
  postAltText: null,
  sourceGroundingSourceKind: "caption",
  sourceGroundingSourceCaption: preparedDuplicate.sourceCaption,
  sourceGroundingInstagramPostId: preparedDuplicate.instagramPostId,
  sourceGroundingInstagramPostUrl: preparedDuplicate.instagramPostUrl,
  sourceGroundingInstagramHandle: "qa_venue",
  sourceGroundingVersion: 4,
  sourceGroundingEvidence: "instagram_caption",
  approvalTitleSensible: true,
  approvalCaptionSourceCoherent: true,
  sourceGroundingVerified: true,
  sourceGroundingTitleVerified: true,
  sourceGroundingDateVerified: true,
  sourceGroundingIdentityVerified: true,
  sourceGroundingIdentityContextVerified: true,
  sourceGroundingTimeVerified: true,
  sourceGroundingArtistsVerified: true,
  sourceGroundingRowVerified: true,
  moderationAutoApproved: true,
  moderationAutoApproveRule: "source_grounded_core_event_fields",
  moderationPendingReasons: [],
  moderationSignals: [],
  moderationConfidenceScore: 0.95,
  normalizedDate: "2026-07-15",
  normalizedVenue: "QA Venue",
  normalizedIsValid: true,
  titleUsedFallback: false,
  dateSuspiciousYear: false,
  dateConfidence: "high",
  missingImage: false,
  moderationAllowMissingImage: false,
});
const pendingAutoApprovedDuplicate = buildDuplicateUpdatePatch(
  { ...existingDuplicate, status: "pending" },
  {
    ...preparedDuplicate,
    status: "approved",
    normalizedFieldsJson: completeSourceGroundedApprovalJson,
  },
);
assert.equal(pendingAutoApprovedDuplicate.statusAutoApproved, true);
assert.equal(pendingAutoApprovedDuplicate.patch.status, "approved");
assert.equal(pendingAutoApprovedDuplicate.protectedApprovedFromPending, false);
const rejectedAutoApprovedDuplicate = buildDuplicateUpdatePatch(
  { ...existingDuplicate, status: "rejected" },
  {
    ...preparedDuplicate,
    status: "approved",
    normalizedFieldsJson: completeSourceGroundedApprovalJson,
  },
);
assert.equal(rejectedAutoApprovedDuplicate.statusAutoApproved, false);
assert.equal(rejectedAutoApprovedDuplicate.statusResetToPending, true);
assert.equal(rejectedAutoApprovedDuplicate.patch.status, "pending");
const completeApprovedDuplicate = buildDuplicateUpdatePatch(
  { ...existingDuplicate, status: "approved" },
  {
    ...preparedDuplicate,
    status: "approved",
    normalizedFieldsJson: completeSourceGroundedApprovalJson,
  },
);
assert.equal(
  completeApprovedDuplicate.protectedApprovedFromPending,
  true,
  "Even a fully grounded service replay must not rewrite an already approved public event.",
);
assert.deepEqual(completeApprovedDuplicate.patch, {});
const duplicateRepair = buildDuplicateUpdatePatch(existingDuplicate, preparedDuplicate);
assert.deepEqual(
  {
    timeSource: duplicateRepair.patch.timeSource,
    timeEvidenceText: duplicateRepair.patch.timeEvidenceText,
    timeConfidence: duplicateRepair.patch.timeConfidence,
    timeStatus: duplicateRepair.patch.timeStatus,
  },
  {
    timeSource: "caption",
    timeEvidenceText: "Početak 21H",
    timeConfidence: 0.95,
    timeStatus: "confirmed",
  },
  "Duplicate repair must propagate all event-time provenance fields.",
);
const unknownDuplicateRepair = buildDuplicateUpdatePatch(existingDuplicate, {
  ...preparedDuplicate,
  timeSource: "unknown",
  timeEvidenceText: undefined,
  timeConfidence: 0,
  timeStatus: "unknown",
});
assert.equal(unknownDuplicateRepair.patch.timeSource, "unknown");
assert.equal(unknownDuplicateRepair.patch.timeConfidence, 0);
assert.equal(unknownDuplicateRepair.patch.timeStatus, "unknown");
assert.equal(
  Object.hasOwn(unknownDuplicateRepair.patch, "timeEvidenceText"),
  true,
  "Duplicate repair must explicitly clear stale evidence.",
);
assert.equal(unknownDuplicateRepair.patch.timeEvidenceText, null);
const wireDuplicatePatch = JSON.parse(JSON.stringify(unknownDuplicateRepair.patch));
assert.equal(wireDuplicatePatch.timeEvidenceText, null, "Convex wire serialization must retain the clear sentinel.");
const normalizedWireDuplicatePatch = normalizeEventTimeWritePatch(wireDuplicatePatch);
assert.equal(normalizedWireDuplicatePatch.timeEvidenceText, undefined);
assert.equal(Object.hasOwn(normalizedWireDuplicatePatch, "timeEvidenceText"), true);

const richerSinglePostDuplicate = {
  ...existingDuplicate,
  time: "20:00",
  timeSource: "poster",
  timeEvidenceText: "NEDELJA 19.JUL 20h",
  timeConfidence: 0.95,
  timeStatus: "confirmed",
  artists: ["DJ Džoni"],
  description:
    "DJ Džoni pušta muziku od početka večeri; finale Svetskog prvenstva gleda se od 21:00.",
  imageUrl: "https://example.com/richer-single-post.jpg",
  instagramPostUrl: "https://www.instagram.com/p/richer-single-post/",
  instagramPostId: "richer-single-post",
  sourceCaption: "DJ Džoni bira muziku, a finale gledamo od 21:00.",
  sourcePostedAt: "2026-07-18T09:54:05.000Z",
  rawExtractionJson: JSON.stringify({ source_url: "richer-single-post" }),
  normalizedFieldsJson: JSON.stringify({
    multiEventSplitDetected: false,
    title: "QA Event",
    normalizedDate: "2026-07-15",
    time: "20:00",
    artists: ["DJ Džoni"],
  }),
};
const weakerWeeklyScheduleDuplicate = {
  ...preparedDuplicate,
  time: "TBD",
  timeSource: "unknown",
  timeEvidenceText: undefined,
  timeConfidence: 0,
  timeStatus: "unknown",
  artists: [],
  description: "Weekly venue schedule with several events.",
  imageUrl: "https://example.com/weaker-weekly-schedule.jpg",
  instagramPostUrl: "https://www.instagram.com/p/weaker-weekly-schedule/",
  instagramPostId: "weaker-weekly-schedule",
  sourceCaption: "Nedeljni program: sedam događaja u Bluz i Pivo.",
  sourcePostedAt: "2026-07-18T09:52:49.000Z",
  eventType: "live music",
  rawExtractionJson: JSON.stringify({ source_url: "weaker-weekly-schedule" }),
  normalizedFieldsJson: JSON.stringify({
    multiEventSplitDetected: true,
    multiEventSplitCount: 7,
    title: "QA Event",
    normalizedDate: "2026-07-15",
    time: "TBD",
    artists: [],
  }),
};
const preservedRicherDuplicate = buildDuplicateUpdatePatch(
  richerSinglePostDuplicate,
  weakerWeeklyScheduleDuplicate,
);
assert.deepEqual(
  {
    time: preservedRicherDuplicate.patch.time,
    timeSource: preservedRicherDuplicate.patch.timeSource,
    timeEvidenceText: preservedRicherDuplicate.patch.timeEvidenceText,
    timeConfidence: preservedRicherDuplicate.patch.timeConfidence,
    timeStatus: preservedRicherDuplicate.patch.timeStatus,
    artists: preservedRicherDuplicate.patch.artists,
    description: preservedRicherDuplicate.patch.description,
    imageUrl: preservedRicherDuplicate.patch.imageUrl,
    instagramPostUrl: preservedRicherDuplicate.patch.instagramPostUrl,
    instagramPostId: preservedRicherDuplicate.patch.instagramPostId,
    sourceCaption: preservedRicherDuplicate.patch.sourceCaption,
    sourcePostedAt: preservedRicherDuplicate.patch.sourcePostedAt,
    rawExtractionJson: preservedRicherDuplicate.patch.rawExtractionJson,
    normalizedFieldsJson: preservedRicherDuplicate.patch.normalizedFieldsJson,
    eventType: preservedRicherDuplicate.patch.eventType,
  },
  {
    time: richerSinglePostDuplicate.time,
    timeSource: richerSinglePostDuplicate.timeSource,
    timeEvidenceText: richerSinglePostDuplicate.timeEvidenceText,
    timeConfidence: richerSinglePostDuplicate.timeConfidence,
    timeStatus: richerSinglePostDuplicate.timeStatus,
    artists: richerSinglePostDuplicate.artists,
    description: richerSinglePostDuplicate.description,
    imageUrl: richerSinglePostDuplicate.imageUrl,
    instagramPostUrl: richerSinglePostDuplicate.instagramPostUrl,
    instagramPostId: richerSinglePostDuplicate.instagramPostId,
    sourceCaption: richerSinglePostDuplicate.sourceCaption,
    sourcePostedAt: richerSinglePostDuplicate.sourcePostedAt,
    rawExtractionJson: richerSinglePostDuplicate.rawExtractionJson,
    normalizedFieldsJson: richerSinglePostDuplicate.normalizedFieldsJson,
    eventType: richerSinglePostDuplicate.eventType,
  },
  "A weaker multi-event schedule must not erase richer single-post fields or replace their source provenance.",
);
assert.equal(
  preservedRicherDuplicate.materiallyChanged,
  false,
  "Preserving an already-richer pending event must not be reported as a material rewrite.",
);

assert.deepEqual(normalizeEventTimeWritePatch({ time: "22:00" }), {
  time: "22:00",
  timeSource: "unknown",
  timeEvidenceText: undefined,
  timeConfidence: 0,
  timeStatus: "unknown",
});
assert.deepEqual(
  normalizeEventTimeWritePatch({
    time: "21:00",
    timeSource: "caption",
    timeEvidenceText: "Početak 21H",
    timeConfidence: 0.95,
    timeStatus: "confirmed",
  }),
  {
    time: "21:00",
    timeSource: "caption",
    timeEvidenceText: "Početak 21H",
    timeConfidence: 0.95,
    timeStatus: "confirmed",
  },
);
assert.equal(
  normalizeEventTimeWritePatch({
    timeSource: "unknown",
    timeEvidenceText: null,
    timeConfidence: 0,
    timeStatus: "unknown",
  }).timeEvidenceText,
  undefined,
  "Null evidence must translate to a Convex field removal.",
);
assert.throws(
  () => normalizeEventTimeWritePatch({ timeSource: "caption" }),
  /must provide timeSource, timeConfidence, and timeStatus together/,
);
assert.throws(
  () => normalizeEventTimeWritePatch({ time: "21:00", timeSource: "caption" }),
  /must provide timeSource, timeConfidence, and timeStatus together/,
);

assert.equal(
  resolveEventTimeDisplay({
    date: "2026-07-15",
    time: "TBD",
    venueHours: {
      hoursJson: JSON.stringify({
        generatedAt: "2026-07-01T00:00:00.000Z",
        source: "manual",
        timezone: "Europe/Belgrade",
        version: 1,
        weekly: [
          {
            closed: false,
            day: 3,
            windows: [{ day: 3, end: "02:00", spansNextDay: true, start: "20:00" }],
          },
        ],
      }),
    },
  }).label,
  UNKNOWN_EVENT_TIME_LABEL,
  "Venue hours must never become an event time.",
);
assert.equal(
  getEventTimeProvenanceLabel({
    confidence: 0.95,
    evidenceText: "21H",
    source: "caption",
    status: "confirmed",
  }),
  "Confirmed from caption",
);
assert.equal(
  getEventTimeProvenanceLabel({
    confidence: 0.9,
    evidenceText: "21H",
    source: "alt_text",
    status: "inferred",
  }),
  "Inferred from poster OCR",
);
assert.equal(
  getEventTimeProvenanceLabel({
    confidence: 0,
    evidenceText: null,
    source: "unknown",
    status: "unknown",
  }),
  "No confirmed start-time source",
);

// The 07:00 nightlife rollover must remain stable on both Belgrade DST transition days.
assert.equal(
  getNightlifeDefaultDateKey(new Date("2026-03-29T04:59:00.000Z")),
  "2026-03-28",
  "06:59 Europe/Belgrade after the spring DST jump is still the previous nightlife date.",
);
assert.equal(
  getNightlifeDefaultDateKey(new Date("2026-03-29T05:00:00.000Z")),
  "2026-03-29",
  "07:00 Europe/Belgrade after the spring DST jump rolls to the calendar date.",
);
assert.equal(
  getNightlifeDefaultDateKey(new Date("2026-10-25T05:59:00.000Z")),
  "2026-10-24",
  "06:59 Europe/Belgrade after the autumn DST fallback is still the previous nightlife date.",
);
assert.equal(
  getNightlifeDefaultDateKey(new Date("2026-10-25T06:00:00.000Z")),
  "2026-10-25",
  "07:00 Europe/Belgrade after the autumn DST fallback rolls to the calendar date.",
);

const schemaSource = readFileSync("convex/schema.ts", "utf8");
const eventsSource = readFileSync("convex/events.ts", "utf8");
const ingestionSource = readFileSync("lib/pipeline/run-instagram-ingestion.ts", "utf8");
const publicEventsSource = readFileSync("lib/events/public-events.ts", "utf8");
const adminApiSource = readFileSync("app/api/admin/events/route.ts", "utf8");
const moderationSource = readFileSync("components/admin/moderation-dashboard.tsx", "utf8");
const calendarSource = readFileSync("app/(main)/events-browse-page.tsx", "utf8");
const detailSource = readFileSync("app/(main)/events/[eventId]/page.tsx", "utf8");
const venueHoursSource = readFileSync("components/venues/venue-weekly-hours.tsx", "utf8");

for (const field of ["timeSource", "timeEvidenceText", "timeConfidence", "timeStatus"]) {
  assert.ok(schemaSource.includes(field), `Convex schema should persist ${field}.`);
  assert.ok(eventsSource.includes(field), `Convex event functions should expose ${field}.`);
  assert.ok(ingestionSource.includes(field), `Ingestion should populate ${field}.`);
  assert.ok(publicEventsSource.includes(field), `Public event types should include ${field}.`);
  assert.ok(adminApiSource.includes(field), `Moderation API should include ${field}.`);
  assert.ok(moderationSource.includes(field), `Moderation UI should consume ${field}.`);
}
assert.ok(eventsSource.includes("normalizeEventTimeWritePatch"));
assert.match(
  eventsSource,
  /export const updateEvent[\s\S]*?normalizeEventTimeWritePatch\(args\.patch\)/,
);
assert.match(
  eventsSource,
  /export const mergeApprovedEvents[\s\S]*?normalizeEventTimeWritePatch\(args\.patch\)/,
);
assert.match(
  ingestionSource,
  /const \{ clearTicketPrice, \.\.\.persistedPatch \} = updatePayload\.patch;[\s\S]*?existingMatch\.existingEvent = \{[\s\S]*?\.\.\.persistedPatch,[\s\S]*?clearTicketPrice \? \{ ticketPrice: undefined \}/,
  "The in-memory duplicate snapshot must follow the actual reconciled patch and mirror ticket deletion.",
);
assert.match(eventsSource, /timeEvidenceText:\s*v\.optional\(v\.union\(v\.string\(\), v\.null\(\)\)\)/);
assert.ok(moderationSource.includes("EventTimeProvenanceText"));
assert.equal(
  calendarSource.includes("EventTimeProvenanceText"),
  false,
  "Public event listings must not display extraction provenance, confidence, or evidence text.",
);
assert.equal(
  detailSource.includes("EventTimeProvenanceText"),
  false,
  "Public event details must not display extraction provenance, confidence, or evidence text.",
);
assert.ok(calendarSource.includes("Time not announced") || calendarSource.includes("UNKNOWN_EVENT_TIME_LABEL"));
assert.ok(detailSource.includes("Time not announced") || detailSource.includes("UNKNOWN_EVENT_TIME_LABEL"));
assert.ok(venueHoursSource.includes("Venue hours"), "Venue hours must be explicitly labeled.");
assert.equal(
  publicEventsSource.includes('source: "venue_hours"'),
  false,
  "Public event-time shaping must never promote venue hours to event time.",
);

console.log("QA passed: event-time provenance, source recovery, UI labels, and Belgrade DST are deterministic.");
