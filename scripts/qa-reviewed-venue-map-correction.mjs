import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { assertMapOnlyChange, reviewCorrection, runCorrection, validateCorrection } from "./correct-reviewed-venue-map.mjs";

const plan = {
  convexOrigin: "https://convex.example.com",
  venue: {
    id: "k17bp4t9435fgrfxkbpjb7ax3h897rjd", name: "Vinyl", instagramHandle: "vinyl.belgrade",
    expectedUpdatedAt: 101, expectedLatitude: 44.8085971, expectedLongitude: 20.4583958, expectedLocation: "Belgrade",
    latitude: 44.813957, longitude: 20.4502897, address: "Reviewed Street 8, Beograd",
    sourceUrls: ["https://maps.example.com/reviewed-nightclub"], reviewNote: "Human-reviewed nightclub identity; previous point matched a separate music shop.",
  },
};
const venue = {
  _id: plan.venue.id, _creationTime: 1, name: "Vinyl", instagramHandle: "vinyl.belgrade",
  publicStatus: "published", scrapeActive: true, aliases: ["Vinyl Belgrade"], updatedAt: 101,
  latitude: plan.venue.expectedLatitude, longitude: plan.venue.expectedLongitude, location: "Belgrade",
};
const FINGERPRINT = "a".repeat(64);
assert.equal(validateCorrection(plan), plan);
for (const patch of [
  { expectedUpdatedAt: undefined }, { expectedUpdatedAt: 101.5 }, { expectedLatitude: undefined }, { expectedLatitude: 91 },
  { expectedLongitude: null }, { expectedLocation: undefined }, { address: undefined }, { reviewNote: "Too short" },
]) assert.throws(() => validateCorrection({ ...plan, venue: { ...plan.venue, ...patch } }));
assert.equal(reviewCorrection(venue, plan.venue), "ready");
for (const patch of [
  { _id: "another-id" }, { name: "Another Vinyl" }, { instagramHandle: "another.branch" },
  { publicStatus: "hidden" }, { updatedAt: 102 }, { latitude: 44.8 }, { longitude: 20.4 }, { location: "Changed street" },
]) assert.throws(() => reviewCorrection({ ...venue, ...patch }, plan.venue));
const after = { ...venue, latitude: plan.venue.latitude, longitude: plan.venue.longitude, location: plan.venue.address, updatedAt: 201 };
assert.equal(reviewCorrection(after, plan.venue), "already_set");
assert.doesNotThrow(() => assertMapOnlyChange(venue, after, plan.venue));
for (const patch of [{ latitude: 44.8 }, { location: "Wrong address" }, { updatedAt: 101 }, { name: "Changed" }, { scrapeActive: false }, { aliases: [] }]) {
  assert.throws(() => assertMapOnlyChange(venue, { ...after, ...patch }, plan.venue));
}

function mock(overrides = {}) {
  const state = { venue: structuredClone(venue), receipts: [], patches: [], reads: 0, fingerprints: 0 };
  const adapter = {
    async readVenue() { state.reads += 1; return structuredClone(state.venue); },
    async deploymentFingerprint() { state.fingerprints += 1; return FINGERPRINT; },
    async saveReceipt(value) { state.receipts.push(structuredClone(value)); },
    async patchVenue(id, fields) {
      assert.equal(state.receipts.at(-1).status, "applying", "Persist a durable before receipt before sending a mutation.");
      assert.equal(id, plan.venue.id);
      assert.deepEqual(Object.keys(fields).sort(), ["latitude", "location", "longitude", "updatedAt"]);
      state.patches.push({ id, fields }); Object.assign(state.venue, fields);
    },
    now: () => 201,
    ...overrides,
  };
  return { state, adapter };
}
const previewMock = mock();
const preview = await runCorrection(plan, {}, previewMock.adapter);
assert.equal(preview.status, "ready");
assert.equal(previewMock.state.patches.length, 0);
assert.equal(preview.planHash.length, 64);
const applyOptions = { apply: true, expectedFingerprint: FINGERPRINT, expectedPlanHash: preview.planHash };
const applyMock = mock();
const applied = await runCorrection(plan, applyOptions, applyMock.adapter);
assert.equal(applied.status, "updated");
assert.equal(applyMock.state.patches.length, 1);
assert.deepEqual(applied.before, venue);
assert.deepEqual(applied.after, after);
for (const options of [{ apply: true }, { ...applyOptions, expectedFingerprint: "b".repeat(64) }, { ...applyOptions, expectedPlanHash: "c".repeat(64) }]) {
  const fixture = mock(); await assert.rejects(runCorrection(plan, options, fixture.adapter), /exact preview/);
  assert.equal(fixture.state.patches.length, 0);
}
const changedPlanMock = mock();
await assert.rejects(runCorrection({ ...plan, venue: { ...plan.venue, address: "Different reviewed street" } }, applyOptions, changedPlanMock.adapter), /exact preview/);
assert.equal(changedPlanMock.state.patches.length, 0);
const stale = mock();
stale.adapter.readVenue = async () => (++stale.state.reads === 1 ? venue : { ...venue, updatedAt: 102 });
await assert.rejects(runCorrection(plan, applyOptions, stale.adapter), /revision or old map location changed/);
assert.equal(stale.state.patches.length, 0);
assert.equal(stale.state.receipts.at(-1).status, "applying");
assert.ok(stale.state.receipts.at(-1).failedAt);
const concurrent = mock();
concurrent.adapter.readVenue = async () => (++concurrent.state.reads === 1 ? venue : { ...venue, aliases: [] });
await assert.rejects(runCorrection(plan, applyOptions, concurrent.adapter), /Venue changed after/);
assert.equal(concurrent.state.patches.length, 0);
const deployment = mock();
deployment.adapter.deploymentFingerprint = async () => (++deployment.state.fingerprints === 1 ? FINGERPRINT : "b".repeat(64));
await assert.rejects(runCorrection(plan, applyOptions, deployment.adapter), /deployment changed before/);
assert.equal(deployment.state.patches.length, 0);
const lostResponse = mock();
lostResponse.adapter.patchVenue = async () => { throw new Error("Response lost"); };
await assert.rejects(runCorrection(plan, applyOptions, lostResponse.adapter), /Response lost/);
assert.deepEqual(lostResponse.state.receipts.at(-1).before, venue);
assert.equal(lostResponse.state.receipts.at(-1).error, "Response lost");
const noReceipt = mock();
noReceipt.adapter.saveReceipt = async () => { throw new Error("Receipt storage unavailable"); };
await assert.rejects(runCorrection(plan, applyOptions, noReceipt.adapter), /Receipt storage unavailable/);
assert.equal(noReceipt.state.patches.length, 0);
const unchangedFields = mock();
unchangedFields.adapter.patchVenue = async (_id, fields) => Object.assign(unchangedFields.state.venue, fields, { scrapeActive: false });
await assert.rejects(runCorrection(plan, applyOptions, unchangedFields.adapter), /Unrelated venue fields changed/);
assert.ok(unchangedFields.state.receipts.at(-1).after);
const alreadySet = mock(); alreadySet.state.venue = after;
assert.equal((await runCorrection(plan, applyOptions, alreadySet.adapter)).status, "already_set");
assert.equal(alreadySet.state.patches.length, 0);

const reviewed = JSON.parse(await readFile(new URL("../data/venue-map-correction-vinyl-2026-10-17.json", import.meta.url), "utf8"));
assert.equal(validateCorrection(reviewed), reviewed);
console.log("Reviewed venue map correction QA passed: exact review/preview guards, before receipts, stale/concurrent/deployment rejection, map-only readback, and idempotency; no network or production writes.");
