import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  UNKNOWN_EVENT_TIME_LABEL,
  extractEventTimeEvidenceFromText,
  getEventTimeProvenanceLabel,
  resolveEventTimeDisplay,
} from "../lib/events/event-time.ts";
import { getNightlifeDefaultDateKey } from "../lib/events/nightlife-date.ts";

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
  ["Doors open 8:30 pm", "20:30"],
  ["22h - 05h", "22:00-05:00"],
]) {
  assert.equal(extractEventTimeEvidenceFromText(text)?.time, expected, `time evidence: ${text}`);
}

for (const text of [
  "19.06",
  "11.06-17.06",
  "od 11. do 17. juna",
  "Karte od 1000 RSD",
  "Ulaz od 18+",
  "Adresa: Knez Mihailova 21",
  "Address: 21 Main Street",
  "Kapacitet 20 ljudi",
  "Capacity 21 people",
]) {
  assert.equal(extractEventTimeEvidenceFromText(text), undefined, `reject non-time: ${text}`);
}

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
assert.ok(calendarSource.includes("EventTimeProvenanceText"));
assert.ok(detailSource.includes("EventTimeProvenanceText"));
assert.ok(calendarSource.includes("Time not announced") || calendarSource.includes("UNKNOWN_EVENT_TIME_LABEL"));
assert.ok(detailSource.includes("Time not announced") || detailSource.includes("UNKNOWN_EVENT_TIME_LABEL"));
assert.ok(venueHoursSource.includes("Venue hours"), "Venue hours must be explicitly labeled.");
assert.equal(
  publicEventsSource.includes('source: "venue_hours"'),
  false,
  "Public event-time shaping must never promote venue hours to event time.",
);

console.log("QA passed: event-time provenance, source recovery, UI labels, and Belgrade DST are deterministic.");
