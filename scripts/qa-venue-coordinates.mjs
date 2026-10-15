import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  assertCoordinateOnlyChange,
  reviewVenue,
  validateManifest,
} from "./backfill-venue-coordinates.mjs";

const ORIGIN = "https://convex.example.com";
const ID = "j57abcdefghijklmnopqrstuvwx1234";
const fixtureVenue = {
  _id: ID,
  _creationTime: 1,
  name: "Reviewed Venue",
  instagramHandle: "reviewed.venue",
  aliases: ["Original Venue"],
  category: "club",
  location: "Reviewed Street 1, Belgrade",
  publicStatus: "published",
  scrapeActive: false,
  createdAt: 1,
  updatedAt: 101,
};
const reviewedVenue = {
  id: ID,
  name: fixtureVenue.name,
  instagramHandle: fixtureVenue.instagramHandle,
  expectedUpdatedAt: fixtureVenue.updatedAt,
  latitude: 44.8125,
  longitude: 20.4612,
  sourceUrls: ["https://example.com/reviewed-location"],
};

function manifest(patch = {}) {
  return { convexOrigin: ORIGIN, venues: [structuredClone(reviewedVenue)], ...patch };
}

function manifestVenue(patch) {
  return manifest({ venues: [{ ...reviewedVenue, ...patch }] });
}

const original = manifest();
const originalSnapshot = structuredClone(original);
assert.equal(validateManifest(original), original);
assert.deepEqual(original, originalSnapshot, "Manifest validation must not change the reviewed plan.");

for (const convexOrigin of [
  "http://convex.example.com",
  "https://convex.example.com/",
  "https://convex.example.com/api",
  "https://convex.example.com?target=other",
  "https://operator:secret@convex.example.com",
  "https://convex.example.com#fragment",
]) {
  assert.throws(() => validateManifest(manifest({ convexOrigin })), /exact public HTTPS Convex origin/);
}
assert.throws(() => validateManifest(manifest({ convexOrigin: "not-an-origin" })));
for (const venues of [undefined, null, {}, []]) {
  assert.throws(() => validateManifest(manifest({ venues })), /between 1 and 2000/);
}
const maxVenues = Array.from({ length: 2000 }, (_, index) => ({
  ...reviewedVenue,
  id: `j57${String(index).padStart(28, "0")}`,
}));
assert.equal(validateManifest(manifest({ venues: maxVenues })).venues.length, 2000);
assert.throws(() => validateManifest(manifest({ venues: [...maxVenues, { ...reviewedVenue, id: "j57" + "9".repeat(28) }] })), /between 1 and 2000/);
assert.throws(() => validateManifest(manifest({ venues: [reviewedVenue, reviewedVenue] })), /unique exact Convex ID/);
for (const id of ["", "venue-1", "j57" + "a".repeat(50), "j57" + "A".repeat(28), 123]) {
  assert.throws(() => validateManifest(manifestVenue({ id })), /unique exact Convex ID/);
}
for (const patch of [
  { name: "" }, { name: " " }, { instagramHandle: "" }, { instagramHandle: " " },
  { expectedUpdatedAt: undefined }, { expectedUpdatedAt: NaN }, { expectedUpdatedAt: Infinity },
  { expectedUpdatedAt: "101" },
]) {
  assert.throws(() => validateManifest(manifestVenue(patch)), /reviewed name, handle, and revision/);
}
for (const [latitude, longitude] of [
  [undefined, 20], [44, undefined], [null, 20], [44, null], ["44", 20],
  [NaN, 20], [44, Infinity], [91, 20], [-91, 20], [44, 181], [44, -181], [0, 0],
]) {
  assert.throws(() => validateManifest(manifestVenue({ latitude, longitude })), /valid nonzero coordinate pair/);
}
for (const [latitude, longitude] of [[90, 180], [-90, -180], [0, 20], [44, 0]]) {
  assert.doesNotThrow(() => validateManifest(manifestVenue({ latitude, longitude })));
}
for (const address of [42, null, " ", "a".repeat(301)]) {
  assert.throws(() => validateManifest(manifestVenue({ address })), /reviewed display address/);
}
assert.doesNotThrow(() => validateManifest(manifestVenue({ address: "Verified Street 1, Novi Sad" })));
for (const sourceUrls of [undefined, [], "https://example.com/", Array(6).fill("https://example.com/location")]) {
  assert.throws(() => validateManifest(manifestVenue({ sourceUrls })), /between 1 and 5 public evidence URLs/);
}
for (const source of ["http://example.com/location", "file:///private/location", "https://name:secret@example.com/location", "https://", "not-a-url"]) {
  assert.throws(() => validateManifest(manifestVenue({ sourceUrls: [source] })));
}
assert.doesNotThrow(() => validateManifest(manifestVenue({ sourceUrls: Array(5).fill("https://example.com/location") })));

const reviewedSnapshot = structuredClone(reviewedVenue);
const fixtureSnapshot = structuredClone(fixtureVenue);
assert.equal(reviewVenue(fixtureVenue, reviewedVenue), "ready");
assert.deepEqual(fixtureVenue, fixtureSnapshot, "Preflight must not change the current venue.");
assert.deepEqual(reviewedVenue, reviewedSnapshot, "Preflight must not change the review.");
for (const current of [
  null,
  { ...fixtureVenue, _id: "j57" + "1".repeat(28) },
  { ...fixtureVenue, name: "Renamed Venue" },
  { ...fixtureVenue, instagramHandle: "another.branch" },
]) {
  assert.throws(() => reviewVenue(current, reviewedVenue), /identity changed/);
}
for (const current of [
  { ...fixtureVenue, publicStatus: "hidden", isActive: true },
  { ...fixtureVenue, publicStatus: "pending", isActive: true },
  { ...fixtureVenue, publicStatus: undefined, isActive: false },
  { ...fixtureVenue, publicStatus: undefined },
]) {
  assert.throws(() => reviewVenue(current, reviewedVenue), /no longer published/);
}
assert.equal(reviewVenue({ ...fixtureVenue, publicStatus: undefined, isActive: true }, reviewedVenue), "ready");
assert.equal(reviewVenue({ ...fixtureVenue, isActive: false, scrapeActive: false }, reviewedVenue), "ready", "Public display backfills must not depend on scrape activation.");
for (const patch of [
  { latitude: 44.8 }, { longitude: 20.4 }, { latitude: null, longitude: null },
  { latitude: 0, longitude: 0 }, { latitude: 44.8, longitude: 20.4 },
  { latitude: reviewedVenue.latitude, longitude: 20.4 },
]) {
  assert.throws(() => reviewVenue({ ...fixtureVenue, ...patch }, reviewedVenue), /Refusing to overwrite coordinates/);
}
for (const updatedAt of [102, undefined, NaN]) {
  assert.throws(() => reviewVenue({ ...fixtureVenue, updatedAt }, reviewedVenue), /revision changed/);
}
const alreadyApplied = {
  ...fixtureVenue,
  latitude: reviewedVenue.latitude,
  longitude: reviewedVenue.longitude,
  updatedAt: fixtureVenue.updatedAt + 10,
};
assert.equal(reviewVenue(alreadyApplied, reviewedVenue), "already_set", "Retries must not overwrite a matching point or fail on their stale reviewed revision.");
assert.throws(() => reviewVenue({ ...alreadyApplied, instagramHandle: "another.branch" }, reviewedVenue), /identity changed/, "Idempotency must never excuse an identity conflict.");
assert.throws(() => reviewVenue({ ...alreadyApplied, publicStatus: "hidden" }, reviewedVenue), /no longer published/, "Idempotency must never excuse a public-state conflict.");

assert.doesNotThrow(() => assertCoordinateOnlyChange(fixtureVenue, alreadyApplied, reviewedVenue));
const reversedFields = Object.fromEntries(Object.entries(alreadyApplied).reverse());
assert.doesNotThrow(() => assertCoordinateOnlyChange(fixtureVenue, reversedFields, reviewedVenue), "Property insertion order must not affect readback verification.");
for (const after of [
  null,
  { ...alreadyApplied, latitude: 44.8 },
  { ...alreadyApplied, longitude: 20.4 },
  { ...alreadyApplied, updatedAt: fixtureVenue.updatedAt },
  { ...alreadyApplied, updatedAt: fixtureVenue.updatedAt - 1 },
  { ...alreadyApplied, updatedAt: undefined },
  { ...alreadyApplied, updatedAt: NaN },
  { ...alreadyApplied, updatedAt: Infinity },
]) {
  assert.throws(() => assertCoordinateOnlyChange(fixtureVenue, after, reviewedVenue), /Coordinate verification failed/);
}
for (const patch of [
  { _id: "j57" + "1".repeat(28) }, { name: "Renamed Venue" }, { aliases: [] },
  { instagramHandle: "another.branch" }, { publicStatus: "hidden" }, { scrapeActive: true },
  { location: "Another Street" }, { createdAt: 2 }, { newField: "unexpected" },
]) {
  assert.throws(() => assertCoordinateOnlyChange(fixtureVenue, { ...alreadyApplied, ...patch }, reviewedVenue), /Other venue fields changed/);
}
const missingField = structuredClone(alreadyApplied);
delete missingField.category;
assert.throws(() => assertCoordinateOnlyChange(fixtureVenue, missingField, reviewedVenue), /Other venue fields changed/);
assert.deepEqual(fixtureVenue, fixtureSnapshot, "Readback verification must preserve its before snapshot.");
assert.deepEqual(reviewedVenue, reviewedSnapshot, "Readback verification must preserve the reviewed point.");

const productionManifest = JSON.parse(await readFile(new URL("../data/venue-coordinates-2026-10-15.json", import.meta.url), "utf8"));
assert.equal(validateManifest(productionManifest), productionManifest, "The committed reviewed data must pass the operator's production guards.");

console.log("Venue coordinate QA passed: manifest validation, missing-only identity/revision guards, idempotent retries, and coordinate-only readback (no network or production writes).");
