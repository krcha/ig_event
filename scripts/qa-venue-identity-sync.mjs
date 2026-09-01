import assert from "node:assert/strict";

import {
  setIdentityActive,
  syncVenueRecordIdentities,
  upsertIdentity,
} from "../convex/venueIdentities.ts";
import { DomainError } from "../lib/domain/errors.ts";

const now = new Date("2026-08-27T18:30:00.000Z").getTime();
Date.now = () => now;

function criteriaFrom(configure) {
  const criteria = [];
  const q = {
    eq(field, value) {
      criteria.push([field, value]);
      return q;
    },
  };
  configure(q);
  return criteria;
}

function makeDb() {
  const identities = new Map();
  const venues = new Map();
  let nextId = 1;
  const result = (criteria = []) => ({
    async take(limit) {
      return [...identities.values()]
        .filter((row) => criteria.every(([field, value]) => row[field] === value))
        .slice(0, limit);
    },
  });
  return {
    identities,
    venues,
    async get(id) {
      return venues.get(id) ?? identities.get(id) ?? null;
    },
    async insert(table, value) {
      assert.equal(table, "venueIdentities");
      const id = `identity-${nextId++}`;
      identities.set(id, { _creationTime: now, _id: id, ...structuredClone(value) });
      return id;
    },
    async patch(id, patch) {
      Object.assign(identities.get(id), structuredClone(patch));
    },
    query(table) {
      assert.equal(table, "venueIdentities");
      return {
        ...result(),
        withIndex(_index, configure) {
          return result(criteriaFrom(configure));
        },
      };
    },
  };
}

const db = makeDb();
const venue = {
  _creationTime: 1,
  _id: "venue-1",
  aliases: ["Old Hall"],
  category: "cultural_center",
  createdAt: 1,
  instagramHandle: "venue_one",
  name: "Venue One",
  updatedAt: 1,
};
db.venues.set(venue._id, venue);
await syncVenueRecordIdentities({ db }, venue);
assert.deepEqual(
  [...db.identities.values()].map((identity) => identity.kind).sort(),
  ["alias", "canonical_name", "provider_account"],
);
process.env.CRON_SECRET = "venue-identity-qa-secret";
const managedCanonicalIdentity = [...db.identities.values()].find(
  (identity) => identity.kind === "canonical_name",
);
await assert.rejects(
  setIdentityActive._handler(
    { auth: { getUserIdentity: async () => null }, db },
    {
      active: false,
      id: managedCanonicalIdentity._id,
      serviceSecret: process.env.CRON_SECRET,
    },
  ),
  (error) =>
    error instanceof DomainError && error.code === "RECONCILIATION_CONFLICT",
  "Venue-record identities must only change through venue synchronization.",
);
await assert.rejects(
  upsertIdentity._handler(
    { auth: { getUserIdentity: async () => null }, db },
    {
      kind: "canonical_name",
      rawValue: "Disconnected Canonical Name",
      serviceSecret: process.env.CRON_SECRET,
      venueId: venue._id,
    },
  ),
  (error) =>
    error instanceof DomainError && error.code === "RECONCILIATION_CONFLICT",
);
await assert.rejects(
  upsertIdentity._handler(
    { auth: { getUserIdentity: async () => null }, db },
    {
      kind: "provider_account",
      rawValue: "disconnected_provider",
      serviceSecret: process.env.CRON_SECRET,
      venueId: venue._id,
    },
  ),
  (error) =>
    error instanceof DomainError && error.code === "RECONCILIATION_CONFLICT",
  "Manual provider identities must stay connected to the current venue account.",
);
await upsertIdentity._handler(
  { auth: { getUserIdentity: async () => null }, db },
  {
    kind: "provider_account",
    rawValue: "venue_one",
    serviceSecret: process.env.CRON_SECRET,
    venueId: venue._id,
  },
);
assert.equal(
  [...db.identities.values()].find(
    (identity) =>
      identity.kind === "provider_account" && identity.rawValue === "venue_one",
  ).source,
  "manual",
  "Explicit teaching must promote an existing derived identity to durable manual ownership.",
);
await db.insert("venueIdentities", {
  active: true,
  createdAt: 1,
  kind: "alias",
  normalizedValue: "migrated old hall",
  rawValue: "Migrated Old Hall",
  source: "migration",
  updatedAt: 1,
  venueId: venue._id,
});
await db.insert("venueIdentities", {
  active: true,
  createdAt: 1,
  kind: "alias",
  normalizedValue: "reviewed seed hall",
  rawValue: "Reviewed Seed Hall",
  source: "manual",
  updatedAt: 1,
  venueId: venue._id,
});

await syncVenueRecordIdentities(
  { db },
  {
    ...venue,
    aliases: ["New Hall"],
    instagramHandle: "venue_new",
    name: "Venue Renamed",
    updatedAt: 2,
  },
);
const rows = [...db.identities.values()];
assert.equal(
  rows.find(
    (identity) =>
      identity.kind === "canonical_name" && identity.rawValue === "Venue One",
  ).active,
  false,
);
assert.equal(
  rows.find(
    (identity) =>
      identity.kind === "historical_alias" && identity.rawValue === "Venue One",
  ).active,
  true,
);
assert.equal(
  rows.find(
    (identity) =>
      identity.kind === "provider_account" && identity.rawValue === "venue_one",
  ).active,
  true,
  "A manually promoted historical provider identity must survive venue-record synchronization.",
);
assert.equal(
  rows.find(
    (identity) => identity.rawValue === "Migrated Old Hall",
  ).active,
  false,
  "Backfill-owned identities must retire when the venue record no longer claims them.",
);
assert.equal(
  rows.find((identity) => identity.rawValue === "Reviewed Seed Hall").active,
  true,
  "A reviewed compatibility seed must survive an ordinary venue metadata update after becoming durable manual identity data.",
);
assert.equal(
  rows.find(
    (identity) => identity.kind === "alias" && identity.rawValue === "Old Hall",
  ).active,
  false,
);
assert.equal(
  rows.find(
    (identity) =>
      identity.kind === "provider_account" && identity.rawValue === "venue_new",
  ).active,
  true,
);

await assert.rejects(
  syncVenueRecordIdentities(
    { db },
    {
      ...venue,
      _id: "venue-2",
      aliases: [],
      instagramHandle: "venue_new",
      name: "Conflicting Venue",
    },
  ),
  (error) => error instanceof DomainError && error.code === "VENUE_AMBIGUOUS",
);

{
  const capped = makeDb();
  const cappedVenue = { ...venue, _id: "venue-cap" };
  capped.venues.set(cappedVenue._id, cappedVenue);
  for (let index = 0; index < 50; index += 1) {
    await capped.insert("venueIdentities", {
      active: true,
      createdAt: 1,
      kind: "alias",
      normalizedValue: `existing alias ${index}`,
      rawValue: `Existing Alias ${index}`,
      source: "manual",
      updatedAt: 1,
      venueId: cappedVenue._id,
    });
  }
  await assert.rejects(
    upsertIdentity._handler(
      { auth: { getUserIdentity: async () => null }, db: capped },
      {
        kind: "alias",
        rawValue: "Alias Fifty One",
        serviceSecret: process.env.CRON_SECRET,
        venueId: cappedVenue._id,
      },
    ),
    (error) =>
      error instanceof DomainError && error.code === "RECONCILIATION_CONFLICT",
    "An exact-size identity cohort must reject a 51st insert.",
  );
  assert.equal(
    [...capped.identities.values()].filter((identity) => identity.kind === "alias")
      .length,
    50,
  );
}

{
  const duplicateAliases = makeDb();
  const duplicateVenue = {
    ...venue,
    _id: "venue-duplicate-aliases",
    aliases: Array.from({ length: 60 }, () => "Same Alias"),
  };
  duplicateAliases.venues.set(duplicateVenue._id, duplicateVenue);
  await syncVenueRecordIdentities({ db: duplicateAliases }, duplicateVenue);
  assert.equal(
    [...duplicateAliases.identities.values()].filter(
      (identity) => identity.kind === "alias",
    ).length,
    1,
    "Equivalent venue aliases must be deduplicated before the hard cap is applied.",
  );
  await assert.rejects(
    syncVenueRecordIdentities(
      { db: duplicateAliases },
      {
        ...duplicateVenue,
        aliases: Array.from({ length: 51 }, (_, index) => `Unique Alias ${index}`),
      },
    ),
    (error) =>
      error instanceof DomainError && error.code === "RECONCILIATION_CONFLICT",
    "A venue record cannot synchronize more than 50 unique aliases.",
  );
}

{
  const historicalCap = makeDb();
  const historicalVenue = { ...venue, _id: "venue-history-cap" };
  historicalCap.venues.set(historicalVenue._id, historicalVenue);
  await historicalCap.insert("venueIdentities", {
    active: true,
    createdAt: 1,
    kind: "canonical_name",
    normalizedValue: "venue one",
    rawValue: "Venue One",
    source: "venue_record",
    updatedAt: 1,
    venueId: historicalVenue._id,
  });
  for (let index = 0; index < 50; index += 1) {
    await historicalCap.insert("venueIdentities", {
      active: true,
      createdAt: 1,
      kind: "historical_alias",
      normalizedValue: `historical ${index}`,
      rawValue: `Historical ${index}`,
      source: "observed_source",
      updatedAt: 1,
      venueId: historicalVenue._id,
    });
  }
  const before = historicalCap.identities.size;
  await assert.rejects(
    syncVenueRecordIdentities(
      { db: historicalCap },
      { ...historicalVenue, name: "Venue Renamed" },
    ),
    (error) =>
      error instanceof DomainError && error.code === "RECONCILIATION_CONFLICT",
    "Canonical-name retirement cannot create a 51st historical alias.",
  );
  assert.equal(
    historicalCap.identities.size,
    before,
    "Historical capacity must be checked before any venue identity write.",
  );
}

console.log("Venue identity synchronization QA passed.");
