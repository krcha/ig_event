import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { applyReviewedVenueDetails } from "../convex/venues.ts";

const previousNow = Date.now;
const previousSecret = process.env.CRON_SECRET;
const previousAdmins = process.env.ADMIN_CLERK_USER_IDS;
const now = Date.parse("2026-10-29T17:00:00.000Z");
const serviceSecret = "qa-reviewed-venue-details-secret";
Date.now = () => now;
process.env.CRON_SECRET = serviceSecret;
process.env.ADMIN_CLERK_USER_IDS = "qa-owner";
const sourceUrl = "https://www.google.com/maps/place/Reviewed+Venue/";
const fields = [
  "name", "instagramHandle", "category", "updatedAt", "location", "latitude", "longitude", "neighborhood",
  "hoursSource", "hoursJson", "hoursFetchedAt", "hoursExpiresAt", "hoursTimezone", "hoursError",
  "googlePlaceId", "osmElementId", "osmElementType",
];
const base = {
  _id: "venue-reviewed-details", _creationTime: 1, name: "Reviewed Venue", instagramHandle: "reviewed_venue",
  normalizedInstagramHandle: "reviewed_venue", category: "bar", location: "Old address 1",
  latitude: 44.8, longitude: 20.4, neighborhood: "Old neighborhood", updatedAt: 1, createdAt: 1,
  googlePlaceId: "existing-google-id", osmElementId: "existing-osm-id", osmElementType: "node",
  hoursSource: "manual", hoursJson: "original hours JSON", hoursError: "old-provider-error",
  hoursFetchedAt: now - 86_400_000, hoursExpiresAt: now + 86_400_000, hoursTimezone: "Europe/Belgrade",
  scrapeActive: true, publicStatus: "published",
};
function snapshot(row) {
  return Object.fromEntries(fields.map((field) => [field, row[field] ?? null]));
}
function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))))).digest("hex");
}
function hours(source = "manual", weekly = [{
  day: 4, closed: false, windows: [{ day: 4, start: "22:00", end: "04:00", spansNextDay: true }],
}]) {
  return {
    hoursSource: source, hoursFetchedAt: now, hoursExpiresAt: now + 7 * 86_400_000,
    hoursTimezone: "Europe/Belgrade", hoursError: "",
    hoursJson: JSON.stringify({
      version: 1, source, generatedAt: new Date(now).toISOString(), timezone: "Europe/Belgrade", weekly,
    }),
  };
}
function args(row = base, patch = { location: "Reviewed address 2" }) {
  const expected = snapshot(row);
  return {
    id: row._id, expected, expectedFingerprint: fingerprint(expected), patch,
    importId: "completed-hours-csv-20261029", sourceUrls: [sourceUrl],
    reviewNote: "Reviewed the exact physical venue identity and owner-supplied CSV source evidence.", serviceSecret,
  };
}
function fixture(row = base, subject = null) {
  const tables = {
    venues: [structuredClone(row)], venueAuditLog: [],
    events: [{ _id: "protected-event", venueId: row._id, venue: row.name, venueLocation: row.location, status: "approved" }],
    sourceOccurrences: [{ _id: "protected-occurrence", venueId: row._id, factsJson: "immutable Instagram evidence" }],
    instagramSourceOccurrenceReceipts: [{ _id: "protected-receipt", factsJson: "immutable receipt" }],
    scrapedPosts: [{ _id: "protected-post", caption: "immutable original source caption" }],
  };
  const writes = [];
  const ctx = {
    auth: { async getUserIdentity() { return subject ? { subject } : null; } },
    db: {
      async get(id) { assert.equal(id, row._id); return structuredClone(tables.venues[0]); },
      async patch(id, patch) {
        assert.equal(id, row._id, "Only the reviewed venue may be patched");
        writes.push({ table: "venues", patch: structuredClone(patch) });
        Object.assign(tables.venues[0], structuredClone(patch));
      },
      async insert(table, value) {
        assert.equal(table, "venueAuditLog", "Only the audit receipt may be inserted");
        const id = "reviewed-details-audit";
        tables.venueAuditLog.push({ _id: id, ...structuredClone(value) });
        writes.push({ table, value: structuredClone(value) });
        return id;
      },
      query() { throw new Error("Reviewed metadata import must not query or change event/source tables"); },
    },
  };
  return { ctx, tables, writes };
}
let checks = 0;
async function rejected(change, row = base, subject = null) {
  const test = fixture(row, subject);
  const before = structuredClone(test.tables);
  const input = args(row);
  change(input);
  await assert.rejects(applyReviewedVenueDetails._handler(test.ctx, input));
  assert.deepEqual(test.tables, before, "A rejected review must leave every row unchanged");
  assert.equal(test.writes.length, 0);
  checks += 1;
}

try {
  for (const subject of [null, "qa-owner"]) {
    const test = fixture(base, subject);
    const patch = { location: "Reviewed address 2", latitude: 44.82, longitude: 20.47, neighborhood: "Reviewed district", ...hours() };
    const input = args(base, patch);
    if (subject) delete input.serviceSecret;
    const before = structuredClone(test.tables);
    const result = await applyReviewedVenueDetails._handler(test.ctx, input);
    assert.equal(result.updated, true);
    assert.equal(result.updatedAt, now);
    assert.equal(result.auditLogId, "reviewed-details-audit");
    assert.equal(result.fingerprint, fingerprint(snapshot(test.tables.venues[0])));
    assert.deepEqual(test.tables.venues[0], { ...base, ...patch, updatedAt: now });
    for (const table of ["events", "sourceOccurrences", "instagramSourceOccurrenceReceipts", "scrapedPosts"]) {
      assert.deepEqual(test.tables[table], before[table], `${table} facts must survive reviewed catalog enrichment`);
    }
    assert.deepEqual(test.writes.map((write) => write.table), ["venues", "venueAuditLog"]);
    const receipt = test.tables.venueAuditLog[0];
    assert.equal(receipt.action, "venue.reviewed_details_imported");
    assert.equal(receipt.actor, subject ?? "service:cron");
    assert.deepEqual(JSON.parse(receipt.beforeJson).snapshot, input.expected);
    assert.deepEqual(JSON.parse(receipt.afterJson).snapshot, snapshot(test.tables.venues[0]));
    assert.equal(JSON.parse(receipt.afterJson).importId, input.importId);
    assert.deepEqual(JSON.parse(receipt.afterJson).sourceUrls, input.sourceUrls);
    assert.ok(!JSON.stringify(receipt).includes(serviceSecret), "Audit receipts must not contain service credentials");
    await assert.rejects(applyReviewedVenueDetails._handler(test.ctx, input), /changed after snapshot review/u);
    checks += 1;
  }
  {
    const test = fixture();
    const result = await applyReviewedVenueDetails._handler(test.ctx, args(base, { location: base.location }));
    assert.equal(result.updated, false);
    assert.equal(result.updatedAt, base.updatedAt);
    assert.equal(test.writes.length, 0);
    checks += 1;
  }
  {
    const test = fixture();
    await applyReviewedVenueDetails._handler(test.ctx, args());
    assert.equal(test.tables.venues[0].hoursJson, base.hoursJson, "Address-only review preserves preexisting hours exactly");
    checks += 1;
  }
  for (const weekly of [
    [],
    [{ day: 0, closed: true, windows: [] }],
    [{ day: 0, closed: true, windows: [] }, { day: 5, closed: false, windows: [] }],
    Array.from({ length: 7 }, (_, day) => ({ day, closed: true, windows: [] })),
  ]) {
    const test = fixture();
    await applyReviewedVenueDetails._handler(test.ctx, args(base, hours("manual", weekly)));
    assert.deepEqual(JSON.parse(test.tables.venues[0].hoursJson).weekly, weekly, "Omitted days remain unknown; explicit closures remain closed");
    checks += 1;
  }
  for (const source of ["osm", "google", "manual", "none"]) {
    const test = fixture();
    await applyReviewedVenueDetails._handler(test.ctx, args(base, hours(source, [])));
    checks += 1;
  }
  for (const verified of [true, false]) {
    for (const status of ["temporarily_closed", "permanently_closed"]) {
      const test = fixture();
      const patch = hours("manual", []);
      const parsed = JSON.parse(patch.hoursJson);
      parsed.raw = { operatingStatus: {
        status, verified, sourceUrls: [sourceUrl], checkedAt: new Date(now).toISOString(), reviewAfter: "2026-11-01T00:00:00.000Z",
      } };
      patch.hoursJson = JSON.stringify(parsed);
      await applyReviewedVenueDetails._handler(test.ctx, args(base, patch));
      assert.deepEqual(JSON.parse(test.tables.venues[0].hoursJson).raw.operatingStatus, parsed.raw.operatingStatus);
      checks += 1;
    }
  }
  {
    const test = fixture();
    const patch = hours();
    const parsed = JSON.parse(patch.hoursJson);
    parsed.raw = { operatingStatus: {
      status: "temporarily_closed", verified: true, sourceUrls: [sourceUrl],
      checkedAt: new Date(now).toISOString(), reviewAfter: "2026-11-01T00:00:00.000Z",
    } };
    patch.hoursJson = JSON.stringify(parsed);
    await applyReviewedVenueDetails._handler(test.ctx, args(base, patch));
    assert.deepEqual(JSON.parse(test.tables.venues[0].hoursJson).weekly, parsed.weekly,
      "A closure proof preserves the venue's independently known regular schedule");
    checks += 1;
  }
  for (const field of fields) {
    const row = { ...base, [field]: typeof base[field] === "number" ? base[field] + 1 : `${base[field]} changed` };
    const test = fixture(row);
    await assert.rejects(applyReviewedVenueDetails._handler(test.ctx, args(base)), /changed after snapshot review/u);
    assert.equal(test.writes.length, 0, `CAS must check ${field}, including independent hours-writer updates`);
    checks += 1;
  }
  for (const category of ["promoter", "organizer", "festival"]) await rejected(() => {}, { ...base, category });
  await rejected((input) => { delete input.serviceSecret; });
  await rejected((input) => { input.serviceSecret = "wrong-secret"; });
  await rejected((input) => { delete input.serviceSecret; }, base, "ordinary-viewer");
  await rejected((input) => { input.expectedFingerprint = "a".repeat(64); });
  await rejected((input) => { input.reviewNote = "too short"; });
  await rejected((input) => { input.importId = "unsafe import / file"; });
  await rejected((input) => { input.sourceUrls = []; });
  for (const url of ["http://google.com/maps", "javascript:alert(1)", "https://user:pass@google.com/maps"]) {
    await rejected((input) => { input.sourceUrls = [url]; });
  }
  for (const patch of [
    {}, { location: undefined }, { name: "Cannot rename" }, { status: "approved" }, { sourceCaption: "Cannot rewrite" },
    { latitude: 44.8 }, { latitude: 0, longitude: 0 }, { latitude: 91, longitude: 20 },
    { latitude: 44, longitude: 181 }, { latitude: Number.NaN, longitude: 20 },
    { latitude: 44, longitude: Number.POSITIVE_INFINITY }, { location: " " }, { location: " trailing " },
    { hoursJson: "{}" },
  ]) await rejected((input) => { input.patch = patch; });
  const invalidHours = [
    (value) => { value.version = 2; }, (value) => { value.source = "google"; },
    (value) => { value.timezone = "UTC"; }, (value) => { value.generatedAt = "wrong"; },
    (value) => { value.weekly[0].day = 7; }, (value) => { value.weekly.push(value.weekly[0]); },
    (value) => { value.weekly[0].closed = true; }, (value) => { delete value.weekly[0].closed; },
    (value) => { value.weekly[0].windows[0].end = "24:00"; },
    (value) => { value.weekly[0].windows[0].day = 3; },
    (value) => { delete value.weekly[0].windows[0].spansNextDay; },
    (value) => { value.raw = { operatingStatus: { status: "unknown", verified: true } }; },
    (value) => { value.raw = { operatingStatus: { status: "permanently_closed", verified: true, sourceUrls: [] } }; },
    (value) => { value.raw = { operatingStatus: { status: "permanently_closed", verified: true, sourceUrls: ["https://www.example.com/other-proof"], checkedAt: new Date(now).toISOString() } }; },
    (value) => { value.raw = { operatingStatus: { status: "temporarily_closed", verified: true, sourceUrls: [sourceUrl], checkedAt: new Date(now).toISOString(), reviewAfter: "2026-11-01" } }; },
    (value) => { value.raw = { operatingStatus: { status: "temporarily_closed", verified: true, sourceUrls: [sourceUrl], checkedAt: new Date(now).toISOString(), reviewAfter: "2026-02-30" } }; },
  ];
  for (const change of invalidHours) await rejected((input) => {
    input.patch = hours(); const parsed = JSON.parse(input.patch.hoursJson); change(parsed); input.patch.hoursJson = JSON.stringify(parsed);
  });
  await rejected((input) => { input.patch = hours("none"); });
  await rejected((input) => { input.patch = { ...hours(), hoursExpiresAt: now }; });
  await rejected((input) => { input.patch = { ...hours(), hoursExpiresAt: now + 31 * 86_400_000 }; });
  await rejected((input) => { input.patch = { ...hours(), hoursJson: "{" }; });
  console.log(`Reviewed venue details QA passed (${checks} cases: full snapshot CAS, hours races, auth, bounded validation, closure evidence, audit and source preservation).`);
} finally {
  Date.now = previousNow;
  if (previousSecret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = previousSecret;
  if (previousAdmins === undefined) delete process.env.ADMIN_CLERK_USER_IDS; else process.env.ADMIN_CLERK_USER_IDS = previousAdmins;
}
