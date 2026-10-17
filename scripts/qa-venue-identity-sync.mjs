import assert from "node:assert/strict";

import {
  setIdentityActive,
  syncVenueRecordIdentities,
  upsertIdentity,
} from "../convex/venueIdentities.ts";
import { DomainError } from "../lib/domain/errors.ts";
import {
  assertReviewedVenueRenameOccurrences,
  getReviewedReferencedVenueRenameOccurrences,
  renameReferencedVenueWithReviewedEvents,
  updateVenue,
} from "../convex/venues.ts";

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
await upsertIdentity._handler(
  { auth: { getUserIdentity: async () => null }, db },
  {
    kind: "provider_account",
    rawValue: "venue_one_programme",
    serviceSecret: process.env.CRON_SECRET,
    venueId: venue._id,
  },
);
assert.equal(
  [...db.identities.values()].find(
    (identity) =>
      identity.kind === "provider_account" &&
      identity.rawValue === "venue_one_programme",
  ).source,
  "manual",
  "An explicitly reviewed secondary provider account must become durable venue identity data.",
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

{
  const originalAdminIds = process.env.ADMIN_CLERK_USER_IDS;
  const originalSecret = process.env.CRON_SECRET;
  process.env.ADMIN_CLERK_USER_IDS = "qa-venue-admin";
  process.env.CRON_SECRET = "qa-admin-venue-display-rename";
  const nextName = "Jugoslovensko dramsko pozori\u0161te";

  async function makeReferencedRenameContext(subject = null) {
    const state = makeDb();
    const candidate = {
      ...venue,
      aliases: [],
      instagramHandle: "jdp",
      normalizedInstagramHandle: "jdp",
      name: "jdp",
      location: "Kralja Milana 50, Beograd",
      latitude: 44.804,
      longitude: 20.466,
      publicStatus: "published",
      scrapeActive: true,
    };
    state.venues.set(candidate._id, candidate);
    await syncVenueRecordIdentities({ db: state }, candidate);
    const events = ["approved", "pending", "rejected"].map((status) => ({
      _id: `rename-event-${status}`,
      venueId: candidate._id,
      venue: candidate.name,
      venueInstagramHandle: candidate.instagramHandle,
      normalizedVenueInstagramHandle: candidate.instagramHandle,
      normalizedVenueIdentity: "instagram:jdp",
      title: `Source title ${status}`,
      date: "2026-10-18",
      status,
      updatedAt: 10,
    }));
    const protectedTables = new Map([
      ["events", events],
      ["instagramEventSources", events.map((event) => ({
        _id: `source-${event._id}`,
        eventId: event._id,
        sourcePostId: `post-${event._id}`,
        venueClaim: candidate.name,
        updatedAt: 20,
      }))],
      ["scrapedPosts", events.map((event) => ({
        _id: `post-${event._id}`,
        instagramPostId: `instagram-${event._id}`,
        caption: `${event.title} at jdp`,
        aiAnalysis: JSON.stringify({ venue: candidate.name, title: event.title }),
        updatedAt: 25,
      }))],
      ["instagramSourceOccurrenceReceipts", events.map((event) => ({
        _id: `receipt-${event._id}`,
        sourceIdentity: `instagram-post:${event._id}`,
        sourceFingerprint: `fingerprint-${event._id}`,
        expectedKeys: [event._id],
        expectedOccurrences: [{
          key: event._id, date: event.date, venue: candidate.name, title: event.title,
          artists: [], factsJson: JSON.stringify({ venueClaim: candidate.name }),
        }],
        satisfiedKeys: [event._id],
        satisfiedOccurrences: [{ key: event._id, eventId: event._id }],
        deferredChildCount: 0,
        deferredChildKeys: [],
        createdAt: 1,
        updatedAt: 30,
      }))],
      ["sourceOccurrences", [
        ...events.map((event) => ({
          _id: `occurrence-${event._id}`,
          venueId: candidate._id,
          canonicalEventId: event._id,
          state: "satisfied",
          factsJson: JSON.stringify({ venueClaim: candidate.name }),
          normalizedOccurrenceJson: JSON.stringify({ venue: candidate.name }),
          updatedAt: 40,
        })),
        {
          _id: "rename-unbound-occurrence",
          venueId: candidate._id,
          state: "deferred",
          factsJson: JSON.stringify({ venueClaim: candidate.name }),
          updatedAt: 41,
        },
      ]],
    ]);
    const writes = [];
    const context = {
      auth: { async getUserIdentity() { return subject ? { subject } : null; } },
      db: {
        async get(id) {
          return structuredClone(await state.get(id) ??
            [...protectedTables.values()].flat().find((row) => row._id === id) ?? null);
        },
        async patch(id, patch) {
          assert.ok(state.venues.has(id) || state.identities.has(id),
            "A display-name edit must never patch event facts, sources, receipts, or occurrences.");
          writes.push({ id, patch: structuredClone(patch) });
          if (state.venues.has(id)) Object.assign(state.venues.get(id), structuredClone(patch));
          else await state.patch(id, patch);
        },
        async insert(table, value) {
          assert.equal(table, "venueIdentities", "A display-name edit may insert only venue identity records.");
          writes.push({ table, value: structuredClone(value) });
          return state.insert(table, value);
        },
        query(table) {
          if (table === "venueIdentities") return state.query(table);
          const records = table === "venues" ? [...state.venues.values()] : protectedTables.get(table);
          assert.ok(records, `Unexpected display-name rename QA table ${table}`);
          const take = (criteria = []) => ({ async take(limit) {
            return structuredClone(records.filter((row) =>
              criteria.every(([field, value]) => row[field] === value)).slice(0, limit));
          } });
          return { ...take(), withIndex(_index, configure) { return take(criteriaFrom(configure)); } };
        },
      },
    };
    return { state, candidate, protectedTables, writes, context };
  }

  try {
    for (const authorization of ["admin", "service"]) {
      const fixture = await makeReferencedRenameContext(authorization === "admin" ? "qa-venue-admin" : null);
      const originalVenue = structuredClone(fixture.candidate);
      const originalFacts = structuredClone(fixture.protectedTables);
      const result = await updateVenue._handler(fixture.context, {
        id: fixture.candidate._id,
        expectedUpdatedAt: originalVenue.updatedAt,
        patch: { name: nextName },
        ...(authorization === "service" ? { serviceSecret: process.env.CRON_SECRET } : {}),
      });
      assert.equal(result.updated, true);
      assert.ok(result.updatedAt > originalVenue.updatedAt);
      assert.deepEqual(fixture.candidate, { ...originalVenue, name: nextName, updatedAt: result.updatedAt },
        "An admin venue rename must retain the venue ID, handle, location, lifecycle, and all other fields.");
      assert.deepEqual(fixture.protectedTables, originalFacts,
        "Renaming a referenced venue must preserve every approved/pending/rejected event and source fact byte for byte.");
      const identities = [...fixture.state.identities.values()];
      assert.equal(identities.find((row) => row.kind === "canonical_name" && row.rawValue === "jdp").active, false);
      assert.equal(identities.find((row) => row.kind === "canonical_name" && row.rawValue === nextName).active, true);
      assert.equal(identities.find((row) => row.kind === "historical_alias" && row.rawValue === "jdp").active, true,
        "The former canonical venue name must remain available for historical source resolution.");
      assert.equal(identities.find((row) => row.kind === "provider_account" && row.rawValue === "jdp").active, true);
    }

    const denied = await makeReferencedRenameContext();
    await assert.rejects(updateVenue._handler(denied.context, {
      id: denied.candidate._id, patch: { name: nextName },
    }), /Authentication required/u);
    const unauthorizedAdmin = await makeReferencedRenameContext("qa-non-admin");
    await assert.rejects(updateVenue._handler(unauthorizedAdmin.context, {
      id: unauthorizedAdmin.candidate._id, patch: { name: nextName },
    }), /Admin access required/u);
    assert.equal(denied.writes.length + unauthorizedAdmin.writes.length, 0,
      "Unauthenticated and non-admin callers must not write any venue metadata or identities.");

    const guarded = await makeReferencedRenameContext("qa-venue-admin");
    const guardedBefore = structuredClone(guarded.candidate);
    for (const physicalPatch of [
      { instagramHandle: "other_jdp" },
      { category: "bar" },
      { location: "Other Street 1" },
      { latitude: 44.9 },
      { longitude: 20.5 },
    ]) {
      await assert.rejects(updateVenue._handler(guarded.context, {
        id: guarded.candidate._id, patch: { name: nextName, ...physicalPatch },
      }), /require a bounded venue-rebind migration/u,
      "A display-name correction must not authorize changing a referenced venue's physical identity.");
    }
    await assert.rejects(updateVenue._handler(guarded.context, {
      id: guarded.candidate._id, expectedUpdatedAt: guardedBefore.updatedAt - 1, patch: { name: nextName },
    }), /changed after it was reviewed/u);
    guarded.state.venues.set("conflicting-venue", {
      ...guardedBefore,
      _id: "conflicting-venue",
      name: "Other Theatre",
      instagramHandle: "other_theatre",
      aliases: [nextName],
    });
    await assert.rejects(updateVenue._handler(guarded.context, {
      id: guarded.candidate._id, patch: { name: nextName },
    }), /already assigned to Other Theatre/u,
    "A name-only edit must still reject a name claimed as another venue's alias.");
    assert.deepEqual(guarded.candidate, guardedBefore);
    assert.equal(guarded.writes.length, 0,
      "Physical identity conflicts, stale edits, and alias ambiguity must fail before any write.");
  } finally {
    if (originalAdminIds === undefined) delete process.env.ADMIN_CLERK_USER_IDS;
    else process.env.ADMIN_CLERK_USER_IDS = originalAdminIds;
    if (originalSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalSecret;
  }
}

{
  const originalSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "qa-reviewed-rename-secret";
  const publicVenue = { ...venue, publicStatus: "published", scrapeActive: true };
  const satisfied = {
    _id: "rename-satisfied", _creationTime: 1, updatedAt: 10,
    venueId: venue._id, canonicalEventId: "reviewed-event", state: "satisfied",
    factsJson: '{"venueClaim":"Former Hall"}', normalizedOccurrenceJson: '{"venue":"Former Hall"}',
  };
  const deferred = {
    _id: "rename-deferred", _creationTime: 1, updatedAt: 20,
    venueId: venue._id, state: "deferred", sourceOccurrenceKey: "deferred-row-key",
    factsJson: '{"venueClaim":"Former Hall","titleClaim":"Future DJ"}',
    normalizedOccurrenceJson: '{"venue":"Former Hall","title":"Future DJ"}',
  };
  const rows = [satisfied, deferred];
  const renameContext = {
    auth: { async getUserIdentity() { return null; } },
    db: {
      async get(id) { assert.equal(id, venue._id); return publicVenue; },
      query(table) {
        assert.equal(table, "sourceOccurrences");
        return {
          withIndex(index, configure) {
            assert.equal(index, "by_venue");
            assert.deepEqual(criteriaFrom(configure), [["venueId", venue._id]]);
            return { async take(limit) { return structuredClone(rows.slice(0, limit)); } };
          },
        };
      },
    },
  };
  const before = structuredClone(rows);
  const plan = await getReviewedReferencedVenueRenameOccurrences._handler(renameContext, {
    id: venue._id, serviceSecret: process.env.CRON_SECRET,
  });
  const acknowledged = plan.filter((row) => row.canonicalEventId === undefined)
    .map(({ id, updatedAt, snapshotJson }) => ({ id, updatedAt, snapshotJson }));
  const plannedEvents = new Set(["reviewed-event"]);
  assert.throws(() => assertReviewedVenueRenameOccurrences(rows, plannedEvents), /unplanned source occurrence/,
    "Existing rename callers must still reject unreviewed deferred occurrences.");
  assert.doesNotThrow(() => assertReviewedVenueRenameOccurrences(rows, plannedEvents, acknowledged));
  assert.deepEqual(rows, before, "Acknowledging an unbound occurrence must preserve all historical facts and state.");
  for (const patch of [
    { updatedAt: 21 },
    { factsJson: '{"venueClaim":"Other Hall"}' },
    { normalizedOccurrenceJson: '{"title":"Changed DJ"}' },
    { sourceOccurrenceKey: "changed-key" },
    { state: "satisfied", canonicalEventId: "foreign-event" },
    { state: "deferred", canonicalEventId: "foreign-event" },
  ]) {
    assert.throws(() => assertReviewedVenueRenameOccurrences(
      [satisfied, { ...deferred, ...patch }], plannedEvents, acknowledged,
    ), /unplanned source occurrence/, "Every unbound occurrence byte and revision must match the reviewed snapshot.");
  }
  assert.throws(() => assertReviewedVenueRenameOccurrences(rows, plannedEvents, [...acknowledged, ...acknowledged]), /exact safe bound/);
  assert.throws(() => assertReviewedVenueRenameOccurrences(rows, plannedEvents, [{ ...acknowledged[0], id: "other-row" }]), /unplanned source occurrence/);
  assert.throws(() => assertReviewedVenueRenameOccurrences([satisfied], plannedEvents, acknowledged), /unplanned source occurrence/);
  assert.throws(() => assertReviewedVenueRenameOccurrences(Array(33).fill(satisfied), plannedEvents), /exact safe bound/);
  await assert.rejects(getReviewedReferencedVenueRenameOccurrences._handler(renameContext, {
    id: venue._id, serviceSecret: "incorrect-secret",
  }), /Authentication required/);
  assert.deepEqual(rows, before);
  if (originalSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = originalSecret;
}

{
  const retainedSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "qa-unbound-only-rename";
  const state = makeDb();
  const candidate = { ...venue, name: "Generic Profile Caption", aliases: [],
    publicStatus: "published", scrapeActive: true, location: "Old Address 1",
    latitude: 44.81, longitude: 20.46, source: "legacy",
  };
  state.venues.set(candidate._id, candidate);
  const historical = [{ _id: "historical-only", _creationTime: 1, updatedAt: 11,
    venueId: candidate._id, state: "deferred", sourceOccurrenceKey: "historical-row",
    factsJson: '{"venueClaim":"Generic Profile Caption"}', normalizedOccurrenceJson: '{"time":"TBD"}',
  }];
  const events = [];
  const audits = [];
  const writes = [];
  const context = {
    auth: { async getUserIdentity() { return null; } },
    db: {
      async get(id) { return structuredClone(await state.get(id)); },
      async patch(id, patch) {
        writes.push({ id, patch: structuredClone(patch) });
        if (state.venues.has(id)) Object.assign(state.venues.get(id), structuredClone(patch));
        else await state.patch(id, patch);
      },
      async insert(table, value) {
        writes.push({ table, value: structuredClone(value) });
        if (table === "venueAuditLog") { audits.push(structuredClone(value)); return `audit-${audits.length}`; }
        return state.insert(table, value);
      },
      query(table) {
        if (table === "venueIdentities") return state.query(table);
        const records = table === "venues" ? [...state.venues.values()]
          : table === "events" ? events : table === "sourceOccurrences" ? historical : null;
        assert.ok(records, `Unexpected unbound rename QA table ${table}`);
        const take = (criteria = []) => ({ async take(limit) {
          return structuredClone(records.filter((record) =>
            criteria.every(([field, value]) => record[field] === value)).slice(0, limit));
        } });
        return { ...take(), withIndex(_index, configure) { return take(criteriaFrom(configure)); } };
      },
    },
  };
  const reviewed = await getReviewedReferencedVenueRenameOccurrences._handler(context, {
    id: candidate._id, serviceSecret: process.env.CRON_SECRET,
  });
  const args = {
    id: candidate._id, expectedUpdatedAt: candidate.updatedAt, expectedName: candidate.name,
    nextName: "BIFE", nextLocation: "Marsala Birjuzova 2-4, sprat 2, Beograd",
    expectedEvents: [], expectedUnboundOccurrences: reviewed.map(({ id, updatedAt, snapshotJson }) =>
      ({ id, updatedAt, snapshotJson })),
    venueEvidence: "Source profile and caption explicitly identify the venue and full street address.",
    auditNote: "Reviewed physical venue name and address; retain the exact historical unbound source row unchanged.",
    serviceSecret: process.env.CRON_SECRET,
  };
  const historicalBefore = structuredClone(historical);
  const candidateBefore = structuredClone(candidate);
  await assert.rejects(renameReferencedVenueWithReviewedEvents._handler(context, {
    ...args, expectedUnboundOccurrences: [],
  }), /exact bounded reviewed plan/u, "A zero-event plan must acknowledge a nonempty historical occurrence set.");
  for (const nextLocation of ["", "  Street 1", "Street  1", "x".repeat(301)]) {
    await assert.rejects(renameReferencedVenueWithReviewedEvents._handler(context, { ...args, nextLocation }),
      /exact bounded reviewed plan/u, "A supplied location must be nonempty, canonical, and bounded.");
  }
  await assert.rejects(renameReferencedVenueWithReviewedEvents._handler(context, {
    ...args, expectedUpdatedAt: candidate.updatedAt - 1,
  }), /changed after plan review/u);
  historical[0].factsJson = '{"venueClaim":"Changed source"}';
  await assert.rejects(renameReferencedVenueWithReviewedEvents._handler(context, args), /unplanned source occurrence/u);
  Object.assign(historical[0], historicalBefore[0]);
  for (const patch of [
    { state: "satisfied", canonicalEventId: "foreign-event" },
    { state: "deferred", canonicalEventId: "foreign-event" },
  ]) {
    Object.assign(historical[0], patch);
    const foreignPlan = await getReviewedReferencedVenueRenameOccurrences._handler(context, {
      id: candidate._id, serviceSecret: process.env.CRON_SECRET,
    });
    await assert.rejects(renameReferencedVenueWithReviewedEvents._handler(context, {
      ...args, expectedUnboundOccurrences: foreignPlan.map(({ id, updatedAt, snapshotJson }) => ({ id, updatedAt, snapshotJson })),
    }), /unplanned source occurrence/u, "An explicitly acknowledged row cannot authorize a foreign canonical event reference.");
    for (const key of Object.keys(historical[0])) delete historical[0][key];
    Object.assign(historical[0], structuredClone(historicalBefore[0]));
  }
  events.push({ _id: "unplanned-event", venueId: candidate._id });
  await assert.rejects(renameReferencedVenueWithReviewedEvents._handler(context, args), /event set changed/u);
  events.splice(0);
  events.push({ _id: "foreign-legacy-binding", venueId: "other-venue", normalizedVenueInstagramHandle: candidate.instagramHandle });
  await assert.rejects(renameReferencedVenueWithReviewedEvents._handler(context, args), /unplanned legacy event binding/u);
  events.splice(0);
  assert.deepEqual(candidate, candidateBefore);
  assert.equal(writes.length, 0, "All rejected plans must leave the venue, identities, history, and audits untouched.");
  const result = await renameReferencedVenueWithReviewedEvents._handler(context, args);
  assert.equal(result.renamed, true);
  assert.equal(result.eventCount, 0);
  assert.equal(candidate.name, args.nextName);
  assert.equal(candidate.location, args.nextLocation);
  assert.equal(candidate.latitude, candidateBefore.latitude);
  assert.equal(candidate.longitude, candidateBefore.longitude);
  assert.equal(candidate.source, candidateBefore.source);
  assert.equal(candidate.scrapeActive, candidateBefore.scrapeActive);
  assert.deepEqual(historical, historicalBefore, "A reviewed unbound-only rename must preserve every historical source field byte for byte.");
  assert.equal(JSON.parse(audits[0].beforeJson).location, candidateBefore.location);
  assert.equal(JSON.parse(audits[0].afterJson).location, args.nextLocation);
  assert.deepEqual(JSON.parse(audits[0].afterJson).preservedUnboundOccurrences,
    [{ id: historical[0]._id, updatedAt: historical[0].updatedAt }]);
  if (retainedSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = retainedSecret;
}

console.log("Venue identity synchronization and reviewed rename occurrence QA passed.");
