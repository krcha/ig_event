import assert from "node:assert/strict";
import { applyReviewedMissingHours } from "../convex/venueHoursBackfill.ts";

const now = Date.parse("2026-10-21T12:00:00.000Z");
Date.now = () => now;
process.env.CRON_SECRET = "venue-hours-backfill-qa-secret";
const id = "venue-reviewed-hours";
const base = {
  _id: id, _creationTime: 1, name: "Reviewed Venue", instagramHandle: "reviewed_venue",
  category: "bar", location: "Reviewed address", latitude: 44.8, longitude: 20.4,
  googlePlaceId: "existing-place-id", osmElementId: "existing-osm-id", osmElementType: "node",
  scrapeActive: true, publicStatus: "published", createdAt: 1, updatedAt: 2,
};
const snapshotFields = [
  "name", "instagramHandle", "category", "location", "latitude", "longitude", "updatedAt",
  "hoursSource", "hoursJson", "hoursFetchedAt", "hoursExpiresAt", "hoursTimezone",
  "osmElementId", "osmElementType", "googlePlaceId", "hoursError",
];
function expected(row) {
  return Object.fromEntries(snapshotFields.map((key) => [key, row[key] ?? null]));
}
function schedule(source = "google", weekly = [{
  day: 2, closed: false, windows: [{ day: 2, start: "20:00", end: "02:00", spansNextDay: true }],
}]) {
  return { version: 1, source, generatedAt: new Date(now).toISOString(), timezone: "Europe/Belgrade", weekly };
}
function args(row, source = "google", provider = "google_maps") {
  return {
    id, expected: expected(row),
    patch: {
      hoursSource: source, hoursJson: JSON.stringify(schedule(source)), hoursFetchedAt: now,
      hoursExpiresAt: now + 7 * 86_400_000, hoursTimezone: "Europe/Belgrade",
    },
    evidence: { provider, sourceUrls: [provider === "facebook"
      ? "https://www.facebook.com/reviewedvenue/about/"
      : "https://www.google.com/maps/place/Reviewed+Venue/"], observedAt: now },
    serviceSecret: process.env.CRON_SECRET,
  };
}
function database(row = base) {
  let current = row === null ? null : structuredClone(row);
  const writes = [];
  return {
    get current() { return current; },
    set current(value) { current = value; },
    writes,
    context: {
      auth: { getUserIdentity: async () => null },
      db: {
        async get(requestedId) { assert.equal(requestedId, id); return structuredClone(current); },
        async patch(requestedId, patch) {
          assert.equal(requestedId, id);
          writes.push(structuredClone(patch));
          current = { ...current, ...structuredClone(patch) };
        },
      },
    },
  };
}
let checks = 0;
async function skipped(row, reason, supplied = args(row ?? base)) {
  const db = database(row);
  assert.deepEqual(await applyReviewedMissingHours._handler(db.context, supplied), { id, status: "skipped", reason });
  assert.deepEqual(db.current, row);
  assert.equal(db.writes.length, 0);
  checks += 1;
}

for (const [source, provider, url] of [
  ["google", "google_maps", "https://www.google.com/maps/place/Reviewed+Venue/"],
  ["manual", "facebook", "https://www.facebook.com/reviewedvenue/about/"],
  ["manual", "google_maps", "https://maps.app.goo.gl/reviewedvenue"],
]) {
  const db = database();
  const input = args(base, source, provider);
  input.evidence.sourceUrls = [url];
  assert.deepEqual(await applyReviewedMissingHours._handler(db.context, input), { id, status: "applied", reason: "applied" });
  const written = JSON.parse(db.current.hoursJson);
  assert.deepEqual(written.weekly, schedule(source).weekly, "Tuesday window must still end on Wednesday at 02:00.");
  assert.equal(written.raw.provider, provider);
  assert.equal(written.raw.observedAt, new Date(now).toISOString());
  assert.deepEqual(written.raw.sourceUrls, [url]);
  assert.equal(db.current.hoursError, "");
  assert.deepEqual(Object.fromEntries(Object.entries(db.current).filter(([key]) => !Object.keys(db.writes[0]).includes(key))), base,
    "Provider identifiers, lifecycle, coordinates, updatedAt, and all other fields must remain exact.");
  assert.equal(db.writes.length, 1);
  await skipped(db.current, "hours_changed", input);
  checks += 1;
}

const emptyNone = { ...base, hoursSource: "none", hoursJson: JSON.stringify(schedule("none", [])), hoursError: "old_no_match" };
{
  const db = database(emptyNone);
  assert.equal((await applyReviewedMissingHours._handler(db.context, args(emptyNone))).status, "applied");
  assert.equal(db.current.googlePlaceId, base.googlePlaceId);
  checks += 1;
}
for (const weekly of [
  schedule().weekly,
  [{ day: 2, closed: true, windows: [] }],
  Array.from({ length: 7 }, (_, day) => ({ day, closed: true, windows: [] })),
]) {
  for (const source of ["google", "manual", "osm", "none"]) {
    const row = { ...base, hoursSource: source, hoursJson: JSON.stringify(schedule(source, weekly)), hoursExpiresAt: now - 1 };
    await skipped(row, "existing_hours");
  }
}
for (const hoursJson of [
  "not-json", "null", "{}",
  JSON.stringify(schedule("google", [{ day: 2, closed: false, windows: [{ day: 2, start: "bad", end: "02:00" }] }])),
  JSON.stringify(schedule("manual", [{ day: 2, closed: false, windows: [] }, { day: 2, closed: false, windows: [] }])),
]) await skipped({ ...base, hoursJson }, "protected_hours");

for (const field of ["name", "instagramHandle", "category", "location", "latitude", "longitude", "updatedAt"]) {
  const row = { ...base, [field]: typeof base[field] === "number" ? base[field] + 1 : `${base[field]} changed` };
  await skipped(row, "identity_changed", args(base));
}
for (const field of ["hoursSource", "hoursJson", "hoursFetchedAt", "hoursExpiresAt", "hoursTimezone", "osmElementId", "osmElementType", "googlePlaceId", "hoursError"]) {
  const value = field === "hoursSource" ? "manual" : field.endsWith("At") ? now : `${field}-changed`;
  const row = { ...base, [field]: value };
  await skipped(row, "hours_changed", args(base));
}
// Another writer can add hours without bumping updatedAt. The complete hours
// snapshot, rather than general venue revision alone, must prevent overwrite.
await skipped({ ...base, hoursJson: JSON.stringify(schedule("manual")), hoursSource: "manual" }, "hours_changed", args(base));
await skipped({ ...base, category: "promoter" }, "not_physical");
await skipped(null, "not_found");

async function rejected(change) {
  const db = database();
  const input = args(base);
  change(input);
  await assert.rejects(applyReviewedMissingHours._handler(db.context, input));
  assert.deepEqual(db.current, base);
  assert.equal(db.writes.length, 0);
  checks += 1;
}
await rejected((input) => { delete input.serviceSecret; });
await rejected((input) => { input.serviceSecret = "wrong-secret"; });
for (const url of ["http://www.google.com/maps/place/venue", "https://google.com.attacker.example/maps", "https://user:pass@google.com/maps", "https://www.google.com/search?q=venue", "https://facebook.com/venue", `https://google.com/maps/${"x".repeat(2048)}`]) {
  await rejected((input) => { input.evidence.sourceUrls = [url]; });
}
await rejected((input) => { input.evidence.sourceUrls = []; });
await rejected((input) => { input.evidence.sourceUrls = Array(6).fill(input.evidence.sourceUrls[0]); });
await rejected((input) => { input.evidence.provider = "facebook"; input.evidence.sourceUrls = ["https://facebook.com/venue"]; });
await rejected((input) => { input.patch.hoursExpiresAt += 1; });
await rejected((input) => { input.patch.hoursExpiresAt = now; });
await rejected((input) => { input.evidence.observedAt = now + 1; });
await rejected((input) => { input.patch.hoursFetchedAt = now - 8 * 86_400_000; });
await rejected((input) => { input.patch.hoursJson = " ".repeat(32_769); });
await rejected((input) => { input.patch.hoursJson = "{"; });
for (const change of [
  (json) => { json.source = "manual"; },
  (json) => { json.timezone = "UTC"; },
  (json) => { json.generatedAt = new Date(now - 1).toISOString(); },
  (json) => { json.weekly = []; },
  (json) => { json.weekly[0].windows[0].end = "24:00"; },
  (json) => { delete json.weekly[0].windows[0].spansNextDay; },
  (json) => { json.weekly[0].windows[0].day = 3; },
  (json) => { json.weekly[0].closed = true; },
  (json) => { json.weekly.push(structuredClone(json.weekly[0])); },
]) await rejected((input) => { const json = JSON.parse(input.patch.hoursJson); change(json); input.patch.hoursJson = JSON.stringify(json); });

console.log(`Venue hours backfill checks passed (${checks} cases: atomic snapshot guards, existing-hours preservation, reviewed provenance, overnight windows, auth, bounds, and invalid schedules).`);
