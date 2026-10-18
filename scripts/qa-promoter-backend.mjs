import assert from "node:assert/strict";

import {
  getIngestionContextsByHandles,
  listLegacyVenueSourcesPage,
} from "../convex/instagramSources.ts";
import {
  buildConvexVenueSnapshot,
  getPublicVenueResolverSnapshot,
  resolveVenueClaimsForWrite,
  resolveVenueForWrite,
  resolveVenueFromSnapshot,
} from "../convex/venueResolver.ts";
import { syncVenueRecordIdentities } from "../convex/venueIdentities.ts";
import {
  getPublicVenuePage,
  listPublicVenueDirectory,
  listPublicVenueFields,
  listPublicVenueFieldsByIds,
  listScrapeActiveVenues,
  updateVenue,
} from "../convex/venues.ts";
import {
  getPublicApprovedEventHandler,
  listPublicCalendarEventsWindowPaginatedHandler,
} from "../convex/eventDomain/publicReads.ts";
import {
  listFavoriteVenues,
  toggleFavoriteVenue,
} from "../convex/users.ts";
import { normalizeVenueComparableText } from "../lib/pipeline/venue-normalization.ts";

const previousSecret = process.env.CRON_SECRET;
const serviceSecret = "qa-promoter-backend-secret";
process.env.CRON_SECRET = serviceSecret;

function venue(id, overrides = {}) {
  return {
    _id: id,
    _creationTime: 1,
    aliases: [],
    category: "club",
    createdAt: 1,
    instagramHandle: id.replaceAll("-", "_"),
    normalizedInstagramHandle: id.replaceAll("-", "_"),
    latitude: 44.81,
    location: "Existing physical address",
    longitude: 20.46,
    name: `Place ${id}`,
    publicStatus: "published",
    scrapeActive: true,
    updatedAt: 1,
    ...overrides,
  };
}

function identity(id, owner, kind, rawValue, overrides = {}) {
  return {
    _id: id,
    _creationTime: 1,
    active: true,
    createdAt: 1,
    kind,
    normalizedValue: kind === "provider_account"
      ? rawValue.toLowerCase() : normalizeVenueComparableText(rawValue),
    rawValue,
    source: "manual",
    updatedAt: 1,
    venueId: owner,
    ...(kind === "provider_account" ? { provider: "instagram" } : {}),
    ...overrides,
  };
}

/** Run the actual handlers against bounded indexed reads and recorded writes. */
function fixture(initial = {}, { subject = null, writable = [] } = {}) {
  const tables = {
    events: [],
    eventDomainMigrationState: [],
    favoriteVenues: [],
    instagramSources: [],
    publicationMigrationState: [],
    savedEventMigrationState: [],
    savedEvents: [],
    sourceOccurrences: [],
    sourceOccurrenceTopologyEpoch: [],
    users: [],
    userSavedEvents: [],
    venueAuditLog: [],
    venueIdentities: [],
    venues: [],
    ...structuredClone(initial),
  };
  const reads = [];
  const writes = [];
  let nextId = 0;
  const locate = (id) => Object.entries(tables)
    .map(([table, rows]) => ({ table, row: rows.find((candidate) => candidate._id === id) }))
    .find(({ row }) => row);
  const ctx = {
    auth: { async getUserIdentity() { return subject ? { subject } : null; } },
    scheduler: { async runAfter(...args) { writes.push({ scheduled: args }); } },
    db: {
      normalizeId(table, id) { return tables[table].some((row) => row._id === id) ? id : null; },
      async get(id) {
        reads.push({ id, operation: "get" });
        return structuredClone(locate(id)?.row ?? null);
      },
      async insert(table, value) {
        assert.ok(writable.includes(table), `Unexpected ${table} insert`);
        const row = { _id: `${table}-generated-${++nextId}`, _creationTime: 1, ...structuredClone(value) };
        tables[table].push(row);
        writes.push({ operation: "insert", table, row: structuredClone(row) });
        return row._id;
      },
      async patch(id, patch) {
        const found = locate(id);
        assert.ok(found, `Missing patched row ${id}`);
        assert.ok(writable.includes(found.table), `Unexpected ${found.table} patch`);
        writes.push({ operation: "patch", table: found.table, id, patch: structuredClone(patch) });
        Object.assign(found.row, structuredClone(patch));
      },
      async delete(id) {
        const found = locate(id);
        assert.ok(found && writable.includes(found.table), `Unexpected delete ${id}`);
        writes.push({ operation: "delete", table: found.table, id });
        tables[found.table] = tables[found.table].filter((row) => row._id !== id);
      },
      query(table) {
        assert.ok(Object.hasOwn(tables, table), `Unexpected query table ${table}`);
        const predicates = [];
        let index;
        let descending = false;
        const q = {};
        for (const [name, compare] of Object.entries({
          eq: (left, right) => left === right,
          gte: (left, right) => left >= right,
          gt: (left, right) => left > right,
          lte: (left, right) => left <= right,
          lt: (left, right) => left < right,
        })) {
          q[name] = (field, value) => {
            predicates.push((row) => compare(row[field], value));
            return q;
          };
        }
        const rows = () => {
          const selected = tables[table].filter((row) => predicates.every((predicate) => predicate(row)));
          return structuredClone(descending ? [...selected].reverse() : selected);
        };
        const chain = {
          withIndex(name, configure) { index = name; configure?.(q); return chain; },
          order(direction) { descending = direction === "desc"; return chain; },
          async take(limit) {
            assert.ok(Number.isSafeInteger(limit) && limit > 0, "Reads require an explicit positive bound");
            reads.push({ table, index, operation: "take", limit });
            return rows().slice(0, limit);
          },
          async unique() {
            const selected = rows();
            assert.ok(selected.length <= 1, `Nonunique ${table} query`);
            reads.push({ table, index, operation: "unique" });
            return selected[0] ?? null;
          },
          async first() { reads.push({ table, index, operation: "first" }); return rows()[0] ?? null; },
          async paginate({ cursor, numItems }) {
            assert.ok(Number.isSafeInteger(numItems) && numItems > 0);
            reads.push({ table, index, operation: "paginate", limit: numItems });
            const selected = rows();
            const offset = Number(cursor ?? 0);
            return {
              continueCursor: String(Math.min(selected.length, offset + numItems)),
              isDone: offset + numItems >= selected.length,
              page: selected.slice(offset, offset + numItems),
            };
          },
        };
        return chain;
      },
    },
  };
  return { ctx, reads, tables, writes };
}

try {
  const physical = venue("physical");
  const organizer = venue("organizer", {
    aliases: ["Series Alias"], category: "promoter", name: "Series Organizer",
  });
  const hiddenOrganizer = venue("hidden-organizer", {
    category: "promoter", name: "Hidden Organizer", publicStatus: "hidden",
  });
  const pendingOrganizer = venue("pending-organizer", {
    category: "promoter", name: "Pending Organizer", publicStatus: "pending",
  });

  // Category is authoritative for source context, without overriding activation
  // or reclassifying an explicitly reviewed promoter as a physical venue.
  for (const [label, candidate, source, expected] of [
    ["legacy venue role", organizer, { role: "venue", active: true }, "promoter"],
    ["unknown discovered role", organizer, { role: "unknown", active: true }, "promoter"],
    ["paused explicit source", organizer, { role: "venue", active: false }, "unknown"],
    ["explicit promoter", physical, { role: "promoter", active: true }, "promoter"],
    ["published physical account", physical, { role: "unknown", active: true }, "venue"],
    ["hidden physical account", { ...physical, publicStatus: "hidden" }, { role: "unknown", active: true }, "unknown"],
    ["legacy active promoter", organizer, null, "promoter"],
    ["legacy paused promoter", { ...organizer, scrapeActive: false }, null, "unknown"],
  ]) {
    const context = fixture({
      venues: [candidate],
      instagramSources: source ? [{ _id: "source", handle: candidate.instagramHandle, ...source }] : [],
    });
    const [result] = await getIngestionContextsByHandles._handler(context.ctx, {
      handles: [candidate.instagramHandle], serviceSecret,
    });
    assert.equal(result.role, expected, label);
    assert.equal(context.writes.length, 0, "Role projection must not rewrite source records");
  }
  const legacy = fixture({ venues: [organizer, physical] });
  const legacySources = await listLegacyVenueSourcesPage._handler(legacy.ctx, {
    paginationOpts: { cursor: null, numItems: 25 }, serviceSecret,
  });
  assert.equal(legacySources.page.find((source) => source.handle === organizer.instagramHandle).role, "promoter");
  assert.equal(legacySources.page.find((source) => source.handle === organizer.instagramHandle).venueId, undefined);
  assert.equal(legacySources.page.find((source) => source.handle === physical.instagramHandle).venueId, physical._id);

  const venues = [physical, organizer, hiddenOrganizer, pendingOrganizer];
  const identities = [
    identity("organizer-name", organizer._id, "canonical_name", organizer.name),
    identity("organizer-alias", organizer._id, "alias", organizer.aliases[0]),
    identity("organizer-history", organizer._id, "historical_alias", "Former Series"),
    identity("organizer-provider", organizer._id, "provider_account", "series_secondary"),
    identity("organizer-handle", organizer._id, "provider_account", organizer.instagramHandle),
    identity("physical-name", physical._id, "canonical_name", physical.name),
    identity("misleading-provider", physical._id, "provider_account", organizer.instagramHandle),
    identity("hidden-name", hiddenOrganizer._id, "canonical_name", hiddenOrganizer.name),
    identity("pending-name", pendingOrganizer._id, "canonical_name", pendingOrganizer.name),
  ];
  const excludedClaims = [organizer.name, organizer.aliases[0], "Former Series", "series_secondary", organizer.instagramHandle,
    hiddenOrganizer.name, pendingOrganizer.name];
  const snapshot = buildConvexVenueSnapshot(venues, identities, { includePending: true });
  assert.deepEqual([...snapshot.venueById.keys()], [physical._id]);
  for (const claim of excludedClaims) {
    const result = resolveVenueFromSnapshot(snapshot, claim);
    assert.equal(result.resolution.status, "unresolved", `${claim} must not resolve as a physical place`);
    assert.equal(result.excludedVenueClaim, true, `${claim} must not survive as a proposed venue`);
    assert.equal(result.resolution.proposedName, undefined);
  }
  const resolverFixture = fixture({
    venues, venueIdentities: identities,
    eventDomainMigrationState: [{
      _id: "identity-migration", key: "venue-identities-v1", completedAt: 1, mismatchCount: 0, errorCount: 0,
    }],
  });
  const publicSnapshot = await getPublicVenueResolverSnapshot._handler(resolverFixture.ctx, { serviceSecret });
  assert.deepEqual(publicSnapshot.venues.map((row) => row.id), [physical._id]);
  assert.ok(publicSnapshot.identities.every((row) => row.value !== organizer.instagramHandle),
    "A promoter handle cannot remain a secondary provider identity for another physical venue");
  for (const claim of excludedClaims) assert.ok(publicSnapshot.excludedVenueClaims.includes(claim));
  const indexedResults = await resolveVenueClaimsForWrite(resolverFixture.ctx, [...excludedClaims, physical.name]);
  for (const claim of excludedClaims) {
    assert.equal(indexedResults.get(claim).lookupMode, "indexed_identity");
    assert.equal(indexedResults.get(claim).excludedVenueClaim, true);
    assert.equal(indexedResults.get(claim).resolution.status, "unresolved");
    const single = await resolveVenueForWrite(resolverFixture.ctx, claim, { includePending: true });
    assert.equal(single.excludedVenueClaim, true);
  }
  assert.equal(indexedResults.get(physical.name).venueFields.venueId, physical._id);

  async function referencedFixture(category = "club") {
    const candidate = { ...physical, category };
    const context = fixture({
      venues: [candidate],
      events: [{ _id: "protected-event", venueId: candidate._id, status: "approved", venue: candidate.name, updatedAt: 7 }],
      sourceOccurrences: [{ _id: "protected-occurrence", venueId: candidate._id, factsJson: "immutable source facts", updatedAt: 8 }],
    }, { writable: ["venues", "venueIdentities"] });
    await syncVenueRecordIdentities(context.ctx, candidate);
    context.writes.length = 0;
    return context;
  }
  const transition = await referencedFixture();
  const originalFacts = structuredClone({ events: transition.tables.events, occurrences: transition.tables.sourceOccurrences });
  const beforeVenue = structuredClone(transition.tables.venues[0]);
  const changed = await updateVenue._handler(transition.ctx, {
    id: physical._id, expectedUpdatedAt: beforeVenue.updatedAt, patch: { category: "promoter" }, serviceSecret,
  });
  assert.equal(changed.updated, true);
  assert.deepEqual(transition.tables.venues[0], { ...beforeVenue, category: "promoter", updatedAt: changed.updatedAt });
  assert.deepEqual({ events: transition.tables.events, occurrences: transition.tables.sourceOccurrences }, originalFacts);
  assert.ok(transition.writes.every((write) => ["venues", "venueIdentities"].includes(write.table)),
    "Classifying a referenced promoter must never rewrite or refresh event facts");
  for (const patch of [
    { category: "promoter", location: "Changed address" },
    { category: "promoter", latitude: 44.9 },
    { category: "promoter", longitude: 20.5 },
    { category: "promoter", instagramHandle: "different_account" },
    { category: "bar" },
  ]) {
    const blocked = await referencedFixture(patch.category === "bar" ? "promoter" : "club");
    const before = structuredClone(blocked.tables);
    await assert.rejects(updateVenue._handler(blocked.ctx, {
      id: physical._id, patch, serviceSecret,
    }), /bounded venue-rebind migration/u);
    assert.deepEqual(blocked.tables, before, "A rejected mixed physical edit must be atomic");
    assert.equal(blocked.writes.length, 0);
  }

  const publicFixture = fixture({ venues });
  for (const query of [listPublicVenueFields, listPublicVenueDirectory]) {
    const rows = await query._handler(publicFixture.ctx, { today: "2026-10-18" });
    assert.deepEqual(rows.map((row) => row._id), [physical._id]);
  }
  const byIds = await listPublicVenueFieldsByIds._handler(publicFixture.ctx, { ids: venues.map((row) => row._id) });
  assert.deepEqual(byIds.map((row) => row._id), [physical._id]);
  for (const candidate of [organizer, hiddenOrganizer, pendingOrganizer]) {
    assert.equal(await getPublicVenuePage._handler(publicFixture.ctx, {
      id: candidate._id, today: "2026-10-18",
    }), null, "Promoters do not expose physical-place profiles");
  }
  const scrapeRows = await listScrapeActiveVenues._handler(publicFixture.ctx, { serviceSecret });
  assert.ok(scrapeRows.some((row) => row._id === organizer._id), "Promoter classification must preserve scraping activation");

  const event = (id, linkedVenue, overrides = {}) => ({
    _id: id, _creationTime: 1, artists: [], createdAt: 1, date: "2026-10-18", eventType: "nightlife",
    instagramPostId: `post-${id}`, instagramPostUrl: `https://www.instagram.com/p/${id}/`,
    sourceCaption: "Actual source caption", status: "approved", time: "22:00", title: `Actual title ${id}`, updatedAt: 1,
    venue: "Actual source venue name", venueCategory: linkedVenue.category, venueId: linkedVenue._id,
    venueInstagramHandle: linkedVenue.instagramHandle, venueLatitude: linkedVenue.latitude,
    venueLocation: linkedVenue.location, venueLongitude: linkedVenue.longitude,
    publicationPolicyVersion: 1, publicationReason: "canonical_source_grounding_verified", publicationState: "publishable",
    ...overrides,
  });
  const promoterEvent = event("promoter-event", organizer);
  const physicalEvent = event("physical-event", physical);
  const hiddenEvent = event("hidden-event", hiddenOrganizer);
  const materialized = fixture({
    venues, events: [promoterEvent, physicalEvent, hiddenEvent],
    publicationMigrationState: [{
      _id: "publication-migration", key: "materialized-publication-v1", policyVersion: 1,
      auditDone: true, auditDriftCount: 0, auditScannedCount: 3, auditStartedAt: 100,
      backfillDone: true, completedAt: 200, mismatchCount: 0, phase: "cutover_enabled",
      readCutoverEnabled: true, reviewedAt: 201, reviewedBy: "qa-operator", reviewNote: "Promoter visibility QA",
      scannedCount: 3, sourceTopologyEpoch: 7,
    }],
    sourceOccurrenceTopologyEpoch: [{ _id: "topology", key: "source-occurrence-topology-v1", currentEpoch: 7, verifiedEpoch: 7 }],
    eventDomainMigrationState: [{
      _id: "binding-migration", key: "event-venue-bindings-v1", completedAt: 1, errorCount: 0, isDone: true,
      mismatchCount: 0, quarantinedLineageMarkerCount: 0, scannedCount: 3, skippedCount: 0, unchangedCount: 3, updatedCount: 0,
    }],
  });
  const originalMaterializedFacts = structuredClone(materialized.tables);
  const calendar = await listPublicCalendarEventsWindowPaginatedHandler(materialized.ctx, {
    fromDate: "2026-10-18", beforeDate: "2026-10-19", cursor: null,
  });
  assert.deepEqual(calendar.page.map((row) => row._id), [promoterEvent._id, physicalEvent._id],
    "Physical metadata exclusion must not hide lifecycle-public promoter events");
  const sanitized = calendar.page.find((row) => row._id === promoterEvent._id);
  for (const field of ["venueId", "venueCategory", "venueInstagramHandle", "venueLatitude", "venueLocation", "venueLongitude"]) {
    assert.equal(sanitized[field], undefined, `Promoter event must omit ${field}`);
  }
  for (const field of ["venue", "title", "time", "instagramPostId", "instagramPostUrl"]) {
    assert.equal(sanitized[field], promoterEvent[field], `Physical metadata exclusion must preserve ${field}`);
  }
  assert.equal(calendar.page.find((row) => row._id === physicalEvent._id).venueLatitude, physical.latitude);
  for (const candidate of [physical, organizer, hiddenOrganizer]) {
    assert.equal(materialized.reads.filter((read) => read.operation === "get" && read.id === candidate._id).length, 1,
      "A page must derive both lifecycle and physical metadata sets from the same unique venue read");
  }
  assert.deepEqual(materialized.tables, originalMaterializedFacts);
  assert.equal(materialized.writes.length, 0);

  const compatibilityEvent = event("legacy-promoter-event", organizer, {
    publicationPolicyVersion: undefined, publicationState: undefined, publicationReason: undefined,
  });
  const compatibility = fixture({ venues: [organizer], events: [compatibilityEvent] });
  const detail = await getPublicApprovedEventHandler(compatibility.ctx, { id: compatibilityEvent._id });
  assert.ok(detail, "Legacy-compatible promoter event detail must remain visible");
  assert.equal(detail.venueLatitude, undefined);
  assert.equal(detail.venueId, undefined);
  assert.equal(detail.venue, compatibilityEvent.venue);
  assert.equal(detail.sourceCaption, compatibilityEvent.sourceCaption);

  const favorites = fixture({
    venues: [physical, organizer],
    favoriteVenues: [
      { _id: "favorite-physical", userId: "qa-user", venueId: physical._id, createdAt: 1 },
      { _id: "favorite-promoter", userId: "qa-user", venueId: organizer._id, createdAt: 1 },
    ],
  }, { subject: "qa-user", writable: ["favoriteVenues"] });
  const favoriteList = await listFavoriteVenues._handler(favorites.ctx, { userId: "qa-user" });
  assert.deepEqual(favoriteList.favoriteVenueIds, [physical._id]);
  await assert.rejects(toggleFavoriteVenue._handler(favorites.ctx, {
    userId: "qa-user", venueId: organizer._id, favorite: true,
  }), /Venue not found/u);
  const removed = await toggleFavoriteVenue._handler(favorites.ctx, {
    userId: "qa-user", venueId: organizer._id, favorite: false,
  });
  assert.equal(removed.favorite, false, "A stale promoter favorite must remain removable");
  assert.deepEqual(favorites.tables.favoriteVenues.map((row) => row._id), ["favorite-physical"]);

  console.log("Promoter backend QA passed: source roles, resolver exclusions, bounded type transitions, physical directories, event visibility, and favorites.");
} finally {
  if (previousSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = previousSecret;
}
