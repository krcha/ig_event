import assert from "node:assert/strict";
import { getEventAgeRange, getEventSessionLabel } from "../lib/events/event-session.ts";

const sharedCaption = "Uzrast: 5-8 godina; Vreme 12.00-13.30. Uzrast: 9-14 godina; Vreme 14.00-15.30.";
const sessions = [
  { title: "Mali vajari boja", sourceCaption: sharedCaption, description: "For ages 5\u20138; led by Marija Nikolic with museum curators and guides.", time: "12:00-13:30" },
  { title: "Mali vajari boja", sourceCaption: sharedCaption, description: "For ages 9\u201314; led by Marija Nikolic with museum curators and guides.", time: "14:00-15:30" },
];
const before = structuredClone(sessions);
assert.deepEqual(sessions.map(getEventAgeRange), ["5-8", "9-14"]);
assert.deepEqual(sessions.map(getEventSessionLabel), ["Ages 5\u20138 \u00b7 12:00\u201313:30", "Ages 9\u201314 \u00b7 14:00\u201315:30"]);
assert.deepEqual(sessions, before, "Session labels must not rewrite event facts.");
assert.equal(getEventAgeRange({ sourceCaption: sharedCaption }), null, "A shared caption must never supply an occurrence age group.");
assert.equal(getEventAgeRange({ description: sharedCaption }), null, "An ambiguous combined description must not choose its first group.");
assert.equal(getEventAgeRange({ description: "For ages 5-8 and 9-14." }), null);
assert.equal(getEventAgeRange({ description: "For ages 5-8. Age 5 to 8." }), "5-8");
assert.equal(getEventAgeRange({ description: "Uzrast: od 9 do 14 godina." }), "9-14");
assert.equal(getEventAgeRange({ description: "\u0423\u0437\u0440\u0430\u0441\u0442: 5\u20138 \u0433\u043e\u0434\u0438\u043d\u0430." }), "5-8");
for (const description of [undefined, "", "Workshop from 5-8, no audience specified.", "For ages 14-9.", "For ages 5-140."]) {
  assert.equal(getEventAgeRange({ description }), null, `Reject unsupported age: ${description}`);
}
assert.equal(getEventSessionLabel({ description: "For ages 5-8", time: "TBD" }), "Ages 5\u20138");
assert.equal(getEventSessionLabel({ description: "For ages 5-8", time: "12:00", timeStatus: "unknown" }), "Ages 5\u20138", "Explicit unknown time must not expose an old raw time.");
assert.equal(getEventSessionLabel({ description: "For ages 5-8", time: "12:00", displayTimeLabel: "12:00\u201313:30" }), "Ages 5\u20138 \u00b7 12:00\u201313:30");
assert.equal(getEventSessionLabel({ description: "Music event", time: "22:00" }), null, "Ordinary events should keep their existing compact display.");

console.log("Event session age and time QA passed.");
