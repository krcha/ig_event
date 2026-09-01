import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "csv-parse/sync";

import {
  addReviewedOfficialVenueDirectoryEntries,
  auditVenueCompatibilitySeeds,
  backfillCanonicalEventFieldsBatch,
  backfillEventVenueBindingsBatch,
  backfillMediaCanonicalUrlsBatch,
  backfillSourceDocumentCanonicalUrlsBatch,
  backfillSourceOccurrenceCanonicalPayloadsBatch,
  backfillSourceOccurrencesBatch,
  backfillVenueIdentitiesBatch,
  consolidateReviewedKolaracVenue,
  auditSourceOccurrenceReceiptTopologyBatch,
  REVIEWED_KOLARAC_VENUE_CONSOLIDATION_KEY,
  REVIEWED_OFFICIAL_VENUE_DIRECTORY_ADDITIONS_KEY,
  VENUE_COMPATIBILITY_SEED_AUDIT_KEY,
} from "../convex/internal/migrations/eventDomain.ts";
import { buildEventOccurrenceIndexPatch } from "../convex/sourceOccurrences.ts";
import { parseCanonicalEventPayload } from "../lib/domain/occurrences/canonical-event-payload.ts";
import { serializeStructuredFacts } from "../lib/domain/occurrences/facts.ts";
import { buildInstagramSourceOccurrenceFingerprint } from "../lib/domain/occurrences/source-fingerprint.ts";
import { buildSourceDocumentIdentity } from "../lib/domain/source-documents.ts";
import { LEGACY_VENUE_ALIAS_SEEDS } from "../lib/config/legacy-venue-alias-seeds.ts";
import {
  normalizeHandle,
  normalizeVenueComparableText,
} from "../lib/domain/venues/normalization.ts";
import { isCompleteReceiptTopologyCoverage } from "../convex/internal/receiptTopologyCoverage.ts";
import { isCompleteEventVenueBindingCoverage } from "../convex/internal/eventVenueBindingCoverage.ts";
import { markSourceOccurrenceTopologyMutation } from "../convex/internal/sourceOccurrenceTopologyEpoch.ts";
import {
  buildConvexVenueSnapshot,
  resolveVenueFromSnapshot,
} from "../convex/venueResolver.ts";

const trackedVenueOverrideRows = parse(
  readFileSync("data/venue-name-overrides.csv", "utf8"),
  {
    bom: true,
    columns: true,
    skip_empty_lines: true,
    trim: true,
  },
);
const compatibilitySeedByHandle = new Map(
  LEGACY_VENUE_ALIAS_SEEDS.map((seed) => [
    normalizeHandle(seed.canonicalHandle),
    seed,
  ]),
);
const canonicalSeedHandleByLegacySourceHandle = new Map([
  ["kolarac_art_bioskop", "kolarac_kolarceva_zaduzbina"],
]);
for (const row of trackedVenueOverrideRows) {
  const handle = normalizeHandle(row.ig_handle ?? "");
  const venueName = String(row.venue_name ?? "").trim();
  assert.ok(
    handle && venueName,
    "Tracked venue override rows must be complete.",
  );
  const canonicalSeedHandle =
    canonicalSeedHandleByLegacySourceHandle.get(handle) ?? handle;
  const seed = compatibilitySeedByHandle.get(canonicalSeedHandle);
  assert.ok(
    seed,
    `Tracked venue override @${handle} must map to canonical compatibility seed @${canonicalSeedHandle}.`,
  );
  assert.ok(
    seed.aliases.some(
      (alias) =>
        normalizeVenueComparableText(alias) ===
        normalizeVenueComparableText(venueName),
    ),
    `Tracked venue override @${handle}=${venueName} must be represented by a matching compatibility alias.`,
  );
}

const TABLE_NAMES = [
  "eventDomainMigrationState",
  "events",
  "favoriteVenues",
  "instagramEventSources",
  "instagramSources",
  "instagramSourceOccurrenceReceipts",
  "mediaAssets",
  "scrapedPosts",
  "sourceOccurrences",
  "sourceOccurrenceTopologyEpoch",
  "venueAuditLog",
  "venueIdentities",
  "venues",
];

function makeDb(initial = {}) {
  const tables = Object.fromEntries(
    TABLE_NAMES.map((table) => [
      table,
      new Map(
        (initial[table] ?? []).map((row) => [
          row._id,
          structuredClone(
            table === "venues" &&
              row.isActive === undefined &&
              row.publicStatus === undefined
              ? { ...row, isActive: true }
              : row,
          ),
        ]),
      ),
    ]),
  );
  let nextId = 1;

  function rowsFor(table, filters, direction) {
    const rows = [...tables[table].values()].filter((row) =>
      Object.entries(filters).every(([field, value]) => row[field] === value),
    );
    rows.sort((left, right) => {
      const comparison = String(left._id).localeCompare(String(right._id));
      return direction === "desc" ? -comparison : comparison;
    });
    return rows;
  }

  const db = {
    async get(id) {
      for (const table of Object.values(tables)) {
        if (table.has(id)) return table.get(id);
      }
      return null;
    },
    async insert(table, value) {
      const id = `${table}_${nextId++}`;
      tables[table].set(id, {
        _creationTime: 10_000 + nextId,
        _id: id,
        ...structuredClone(value),
      });
      return id;
    },
    async patch(id, patch) {
      for (const table of Object.values(tables)) {
        if (!table.has(id)) continue;
        table.set(id, { ...table.get(id), ...structuredClone(patch) });
        return;
      }
      throw new Error(`Missing row ${id}.`);
    },
    query(table) {
      const filters = {};
      let direction = "asc";
      const chain = {
        withIndex(_index, apply) {
          const builder = {
            eq(field, value) {
              filters[field] = value;
              return builder;
            },
          };
          apply(builder);
          return chain;
        },
        order(nextDirection) {
          direction = nextDirection;
          return chain;
        },
        async paginate({ cursor, numItems }) {
          const offset = cursor ? Number.parseInt(cursor, 10) : 0;
          const rows = rowsFor(table, filters, direction);
          const page = rows.slice(offset, offset + numItems);
          const nextOffset = offset + page.length;
          return {
            continueCursor: String(nextOffset),
            isDone: nextOffset >= rows.length,
            page,
          };
        },
        async take(limit) {
          return rowsFor(table, filters, direction).slice(0, limit);
        },
        async unique() {
          const rows = rowsFor(table, filters, direction);
          if (rows.length > 1)
            throw new Error("Unique query returned multiple rows.");
          return rows[0] ?? null;
        },
      };
      return chain;
    },
  };
  return { db, tables };
}

function topologyEpochSnapshot(state) {
  const rows = [...state.tables.sourceOccurrenceTopologyEpoch.values()];
  if (rows.length !== 1) return null;
  return {
    currentEpoch: rows[0].currentEpoch,
    verifiedEpoch: rows[0].verifiedEpoch,
  };
}

async function assertAdditiveIdempotentMigration(options) {
  const initialProgressCount =
    options.state.tables.eventDomainMigrationState.size;
  const dryRun = await options.mutation._handler(
    { db: options.state.db },
    { cursor: null, dryRun: true, limit: 25 },
  );
  assert.equal(dryRun.updatedCount, options.expectedUpdates);
  assert.equal(
    options.state.tables.eventDomainMigrationState.size,
    initialProgressCount,
    `${options.label}: dry-run must not write progress.`,
  );
  options.assertDryRun?.();

  const applied = await options.mutation._handler(
    { db: options.state.db },
    { cursor: null, dryRun: false, limit: 25 },
  );
  assert.equal(applied.updatedCount, options.expectedUpdates);
  assert.equal(applied.isDone, true);
  assert.equal(
    options.state.tables.eventDomainMigrationState.size,
    initialProgressCount + 1,
  );
  options.assertApplied();

  const verified = await options.mutation._handler(
    { db: options.state.db },
    { cursor: null, dryRun: true, limit: 25 },
  );
  assert.equal(
    verified.updatedCount,
    0,
    `${options.label}: rerun must be idempotent.`,
  );
}

function cleanVenueCompatibilitySeedAuditState() {
  return {
    _id: "venue_compatibility_seed_audit_ready",
    completedAt: 1,
    createdAt: 1,
    cursor: String(LEGACY_VENUE_ALIAS_SEEDS.length),
    errorCount: 0,
    isDone: true,
    key: VENUE_COMPATIBILITY_SEED_AUDIT_KEY,
    mismatchCount: 0,
    phase: "compatibility_seed_target_audit",
    scannedCount: LEGACY_VENUE_ALIAS_SEEDS.length,
    skipReasonCountsJson: "[]",
    updatedAt: 1,
    updatedCount: 0,
  };
}

function makeReviewedKolaracConsolidationState(overrides = {}) {
  const canonicalVenue = {
    _id: "venue_kolarac_canonical",
    aliases: [
      "Art bioskop Kolarac",
      "Kolarčeva zadužbina",
      "Ilija M. Kolarac Endowment",
    ],
    category: "venue",
    instagramHandle: "kolarac_kolarceva_zaduzbina",
    isActive: true,
    name: "Kolarac",
    normalizedInstagramHandle: "kolarac_kolarceva_zaduzbina",
    publicStatus: "published",
    scrapeActive: true,
    updatedAt: 100,
    ...overrides.canonicalVenue,
  };
  const legacyVenue = {
    _id: "venue_kolarac_legacy",
    category: "venue",
    instagramHandle: "kolarac_art_bioskop",
    isActive: true,
    name: "KolaracArtBioskop",
    normalizedInstagramHandle: "kolarac_art_bioskop",
    updatedAt: 90,
    ...overrides.legacyVenue,
  };
  const canonicalSource = {
    _id: "instagram_source_kolarac_canonical",
    active: true,
    handle: "kolarac_kolarceva_zaduzbina",
    role: "venue",
    updatedAt: 100,
    venueId: canonicalVenue._id,
    ...overrides.canonicalSource,
  };
  const legacySource = {
    _id: "instagram_source_kolarac_legacy",
    active: true,
    handle: "kolarac_art_bioskop",
    role: "venue",
    updatedAt: 90,
    venueId: legacyVenue._id,
    ...overrides.legacySource,
  };
  return makeDb({
    events: overrides.events ?? [],
    favoriteVenues: overrides.favoriteVenues ?? [],
    instagramSources: [
      canonicalSource,
      legacySource,
      ...(overrides.additionalInstagramSources ?? []),
    ],
    sourceOccurrences: overrides.sourceOccurrences ?? [],
    venueIdentities: [
      {
        _id: "legacy_kolarac_name_identity",
        active: true,
        kind: "canonical_name",
        normalizedValue: "kolaracartbioskop",
        rawValue: "KolaracArtBioskop",
        source: "venue_record",
        venueId: legacyVenue._id,
      },
      {
        _id: "legacy_kolarac_provider_identity",
        active: true,
        kind: "provider_account",
        normalizedValue: "kolarac_art_bioskop",
        provider: "instagram",
        rawValue: "kolarac_art_bioskop",
        source: "venue_record",
        venueId: legacyVenue._id,
      },
      {
        _id: "canonical_kolarac_provider_identity",
        active: true,
        kind: "provider_account",
        normalizedValue: "kolarac_kolarceva_zaduzbina",
        provider: "instagram",
        rawValue: "kolarac_kolarceva_zaduzbina",
        source: "venue_record",
        venueId: canonicalVenue._id,
      },
      ...(overrides.additionalVenueIdentities ?? []),
    ],
    venues: [canonicalVenue, legacyVenue],
  });
}

function makeCanonicalPayloadMigrationState() {
  const canonicalSourceUrl =
    "https://www.instagram.com/p/PayloadAttestationPost/";
  const sourceIdentity = buildSourceDocumentIdentity(
    "instagram",
    "PayloadAttestationPost",
  );
  const sourceFingerprint = buildInstagramSourceOccurrenceFingerprint({
    altText: "QA poster alt text",
    caption: "QA caption",
    locationName: "QA Venue",
  });
  const occurrenceKey = "payload-attestation-occurrence";
  const factsJson = serializeStructuredFacts({
    artistClaims: ["QA Artist"],
    eventTypeClaim: "concert",
    evidence: [
      { exactText: "QA Event", field: "title", source: "poster" },
    ],
    localDate: "2026-09-24",
    policy: {
      approvalDisposition: "approved",
      autoApproveRule: "qa_exact_source",
      pendingReasons: [],
      signals: ["poster_title", "poster_date", "resolved_venue"],
      structuredEvidenceVerified: true,
    },
    startTime: "21:00",
    timeRelation: "exact",
    titleClaim: "QA Event",
    venueClaim: "QA Venue",
    venueHandleClaim: "qa_venue",
  });
  const expected = {
    artists: ["QA Artist"],
    date: "2026-09-24",
    factsJson,
    key: occurrenceKey,
    time: "21:00",
    title: "QA Event",
    venue: "QA Venue",
  };
  const normalizedFieldsJson = JSON.stringify({
    artists: expected.artists,
    normalizedDate: expected.date,
    normalizedVenue: expected.venue,
    sourceGroundingInstagramHandle: "qa_venue",
    sourceOccurrenceSourceFingerprint: sourceFingerprint,
    time: expected.time,
    title: expected.title,
  });
  const rawExtractionJson = JSON.stringify({
    contract_version: "event_evidence_v2",
    is_event: true,
  });
  const event = {
    _id: "payload_event",
    artists: expected.artists,
    canonicalSourceUrl,
    createdAt: 100,
    date: expected.date,
    dateEvidenceIsRelative: false,
    dateEvidenceResolvedDate: expected.date,
    dateEvidenceSource: "poster",
    dateEvidenceText: "24 SEP",
    description: "Exact QA description",
    eventType: "concert",
    imageStorageId: "payload_storage",
    imageUrl: "https://eventzeka.example/payload.jpg",
    instagramPostId: "PayloadAttestationPost",
    instagramPostUrl: canonicalSourceUrl,
    normalizedFieldsJson,
    normalizedInstagramPostUrl: canonicalSourceUrl,
    normalizedVenueIdentity: "qa venue",
    normalizedVenueInstagramHandle: "qa_venue",
    occurrenceArtistFingerprint: "",
    rawExtractionJson,
    sourceCaption: "QA caption",
    sourceConflictFields: [],
    sourceOccurrenceKey: occurrenceKey,
    sourcePostedAt: "2026-09-01T10:00:00.000Z",
    status: "approved",
    ticketPrice: "1200 RSD",
    time: expected.time,
    timeConfidence: 1,
    timeEvidenceKind: "start_time_stated",
    timeEvidenceText: "21H",
    timeSource: "poster",
    timeStatus: "confirmed",
    title: expected.title,
    updatedAt: 100,
    venue: expected.venue,
    venueId: "payload_venue",
  };
  const signature = buildEventOccurrenceIndexPatch(event);
  Object.assign(event, signature);
  return makeDb({
    events: [event],
    instagramEventSources: [
      {
        _id: "payload_link",
        canonicalSourceUrl,
        eventId: event._id,
        instagramPostId: "PayloadAttestationPost",
        instagramPostUrl: canonicalSourceUrl,
        linkedAt: 100,
        sourceFingerprint,
        sourceHandle: "qa_venue",
        sourceIdentity,
        sourceOccurrenceId: "payload_occurrence",
        sourceOccurrenceKey: occurrenceKey,
        updatedAt: 100,
      },
    ],
    instagramSourceOccurrenceReceipts: [
      {
        _id: "payload_receipt",
        createdAt: 100,
        deferredChildCount: 0,
        deferredChildKeys: [],
        expectedKeys: [occurrenceKey],
        expectedOccurrences: [expected],
        satisfiedKeys: [occurrenceKey],
        satisfiedOccurrences: [{ eventId: event._id, key: occurrenceKey }],
        sourceFingerprint,
        sourceIdentity,
        updatedAt: 100,
      },
    ],
    scrapedPosts: [
      {
        _id: "payload_document",
        altText: "QA poster alt text",
        analysisResultJson: rawExtractionJson,
        analysisRevision: 2,
        caption: "QA caption",
        handle: "qa_venue",
        imageStorageId: "payload_storage",
        imageUrl: "https://eventzeka.example/payload.jpg",
        imageUrls: ["https://eventzeka.example/payload.jpg"],
        instagramPostUrl: canonicalSourceUrl,
        locationName: "QA Venue",
        postId: "PayloadAttestationPost",
        postedAt: "2026-09-01T10:00:00.000Z",
        processingStatus: "completed",
        sourceRevision: 2,
        username: "qa_venue",
      },
    ],
    sourceOccurrences: [
      {
        _id: "payload_occurrence",
        ...signature,
        canonicalEventId: event._id,
        canonicalSourceUrl,
        createdAt: 100,
        factsJson,
        normalizedOccurrenceJson: JSON.stringify({
          artists: expected.artists,
          date: expected.date,
          eventType: event.eventType,
          time: expected.time,
          title: expected.title,
          venue: expected.venue,
          venueId: event.venueId,
        }),
        occurrenceOrdinal: 0,
        provider: "instagram",
        sourceDocumentId: "payload_document",
        sourceFingerprint,
        sourceIdentity,
        sourceOccurrenceKey: occurrenceKey,
        sourceRevision: 2,
        state: "satisfied",
        updatedAt: 100,
        venueId: event.venueId,
        venueResolutionStatus: "resolved",
      },
    ],
    venues: [
      {
        _id: event.venueId,
        aliases: [],
        instagramHandle: "qa_venue",
        name: expected.venue,
      },
    ],
  });
}

{
  const state = makeReviewedKolaracConsolidationState();
  const legacyVenueBefore = structuredClone(
    state.tables.venues.get("venue_kolarac_legacy"),
  );
  const legacySourceBefore = structuredClone(
    state.tables.instagramSources.get("instagram_source_kolarac_legacy"),
  );
  const dryRun = await consolidateReviewedKolaracVenue._handler(
    { db: state.db },
    { cursor: null, dryRun: true, limit: 1 },
  );
  assert.equal(dryRun.mismatchCount, 0);
  assert.equal(dryRun.updatedCount, 7);
  assert.deepEqual(
    state.tables.venues.get("venue_kolarac_legacy"),
    legacyVenueBefore,
  );
  assert.deepEqual(
    state.tables.instagramSources.get("instagram_source_kolarac_legacy"),
    legacySourceBefore,
  );
  assert.equal(state.tables.venueAuditLog.size, 0);
  assert.equal(state.tables.eventDomainMigrationState.size, 0);

  const applied = await consolidateReviewedKolaracVenue._handler(
    { db: state.db },
    { cursor: null, dryRun: false, limit: 1 },
  );
  assert.equal(applied.mismatchCount, 0);
  assert.equal(applied.updatedCount, 7);
  assert.deepEqual(
    {
      isActive: state.tables.venues.get("venue_kolarac_legacy").isActive,
      publicStatus:
        state.tables.venues.get("venue_kolarac_legacy").publicStatus,
      scrapeActive:
        state.tables.venues.get("venue_kolarac_legacy").scrapeActive,
    },
    { isActive: false, publicStatus: "hidden", scrapeActive: false },
  );
  assert.equal(
    state.tables.instagramSources.get("instagram_source_kolarac_legacy")
      .venueId,
    "venue_kolarac_canonical",
  );
  assert.ok(
    [...state.tables.venueIdentities.values()]
      .filter((identity) => identity.venueId === "venue_kolarac_legacy")
      .every((identity) => identity.active === false),
  );
  assert.deepEqual(
    [...state.tables.venueIdentities.values()]
      .filter(
        (identity) =>
          identity.venueId === "venue_kolarac_canonical" &&
          identity.kind === "provider_account" &&
          identity.normalizedValue === "kolarac_art_bioskop",
      )
      .map((identity) => ({
        active: identity.active,
        provider: identity.provider,
        rawValue: identity.rawValue,
        source: identity.source,
      })),
    [
      {
        active: true,
        provider: "instagram",
        rawValue: "kolarac_art_bioskop",
        source: "manual",
      },
    ],
  );
  assert.equal(state.tables.venueAuditLog.size, 2);
  const progress = [...state.tables.eventDomainMigrationState.values()][0];
  assert.equal(progress.key, REVIEWED_KOLARAC_VENUE_CONSOLIDATION_KEY);
  assert.equal(progress.mismatchCount, 0);
  assert.ok(progress.completedAt);

  const verified = await consolidateReviewedKolaracVenue._handler(
    { db: state.db },
    { cursor: null, dryRun: true, limit: 1 },
  );
  assert.equal(verified.mismatchCount, 0);
  assert.equal(verified.updatedCount, 0);
  assert.equal(verified.unchangedCount, 1);
  assert.equal(
    state.tables.venueAuditLog.size,
    2,
    "Post-apply verification must not duplicate immutable audit evidence.",
  );
}

{
  const blockedFixtures = [
    {
      label: "event reference",
      overrides: {
        events: [{ _id: "legacy_event", venueId: "venue_kolarac_legacy" }],
      },
    },
    {
      label: "source-occurrence reference",
      overrides: {
        sourceOccurrences: [
          { _id: "legacy_occurrence", venueId: "venue_kolarac_legacy" },
        ],
      },
    },
    {
      label: "favorite-venue reference",
      overrides: {
        favoriteVenues: [
          { _id: "legacy_favorite", venueId: "venue_kolarac_legacy" },
        ],
      },
    },
    {
      label: "unexpected InstagramSource reference",
      overrides: {
        additionalInstagramSources: [
          {
            _id: "unexpected_legacy_source_reference",
            active: false,
            handle: "unrelated_source",
            role: "unknown",
            venueId: "venue_kolarac_legacy",
          },
        ],
      },
    },
    {
      label: "reviewed canonical name drift",
      overrides: { canonicalVenue: { name: "Unexpected Kolarac Name" } },
    },
  ];
  for (const fixture of blockedFixtures) {
    const state = makeReviewedKolaracConsolidationState(fixture.overrides);
    const legacyBefore = structuredClone(
      state.tables.venues.get("venue_kolarac_legacy"),
    );
    const sourceBefore = structuredClone(
      state.tables.instagramSources.get("instagram_source_kolarac_legacy"),
    );
    const result = await consolidateReviewedKolaracVenue._handler(
      { db: state.db },
      { cursor: null, dryRun: false, limit: 1 },
    );
    assert.ok(
      result.mismatchCount > 0,
      `${fixture.label} must fail the reviewed consolidation closed.`,
    );
    assert.equal(result.updatedCount, 0);
    assert.deepEqual(
      state.tables.venues.get("venue_kolarac_legacy"),
      legacyBefore,
    );
    assert.deepEqual(
      state.tables.instagramSources.get("instagram_source_kolarac_legacy"),
      sourceBefore,
    );
    assert.equal(state.tables.venueAuditLog.size, 0);
    const progress = [...state.tables.eventDomainMigrationState.values()][0];
    assert.equal(progress.completedAt, undefined);
    assert.ok(progress.mismatchCount > 0);
  }
}

{
  const state = makeDb();
  const dryRun = await addReviewedOfficialVenueDirectoryEntries._handler(
    { db: state.db },
    { cursor: null, dryRun: true, limit: 2 },
  );
  assert.deepEqual(
    {
      mismatchCount: dryRun.mismatchCount,
      scannedCount: dryRun.scannedCount,
      unchangedCount: dryRun.unchangedCount,
      updatedCount: dryRun.updatedCount,
    },
    {
      mismatchCount: 0,
      scannedCount: 2,
      unchangedCount: 0,
      updatedCount: 15,
    },
  );
  assert.equal(state.tables.venues.size, 0);
  assert.equal(state.tables.venueIdentities.size, 0);
  assert.equal(state.tables.venueAuditLog.size, 0);
  assert.equal(state.tables.instagramSources.size, 0);
  assert.equal(state.tables.eventDomainMigrationState.size, 0);

  const applied = await addReviewedOfficialVenueDirectoryEntries._handler(
    { db: state.db },
    { cursor: null, dryRun: false, limit: 2 },
  );
  assert.equal(applied.mismatchCount, 0);
  assert.equal(applied.updatedCount, 15);
  assert.equal(state.tables.venues.size, 2);
  assert.equal(state.tables.venueIdentities.size, 11);
  assert.equal(state.tables.venueAuditLog.size, 2);
  assert.equal(
    state.tables.instagramSources.size,
    0,
    "A reviewed canonical venue addition must not enroll a paid ingestion source.",
  );

  const venuesByHandle = new Map(
    [...state.tables.venues.values()].map((venue) => [
      venue.instagramHandle,
      venue,
    ]),
  );
  assert.deepEqual(
    {
      aliases: venuesByHandle.get("vinarijazvonkobogdan").aliases,
      category: venuesByHandle.get("vinarijazvonkobogdan").category,
      location: venuesByHandle.get("vinarijazvonkobogdan").location,
      name: venuesByHandle.get("vinarijazvonkobogdan").name,
      publicStatus:
        venuesByHandle.get("vinarijazvonkobogdan").publicStatus,
      scrapeActive:
        venuesByHandle.get("vinarijazvonkobogdan").scrapeActive,
    },
    {
      aliases: [
        "Vinarija Zvonko Bogdan Palić",
        "Vinarije Zvonko Bogdan",
        "Vinariji Zvonko Bogdan",
      ],
      category: "venue",
      location: "Kanjiški put 45, Palić",
      name: "Vinarija Zvonko Bogdan",
      publicStatus: "published",
      scrapeActive: false,
    },
  );
  assert.deepEqual(
    {
      aliases: venuesByHandle.get("belgrade_botanical_garden").aliases,
      category: venuesByHandle.get("belgrade_botanical_garden").category,
      location: venuesByHandle.get("belgrade_botanical_garden").location,
      name: venuesByHandle.get("belgrade_botanical_garden").name,
      publicStatus:
        venuesByHandle.get("belgrade_botanical_garden").publicStatus,
      scrapeActive:
        venuesByHandle.get("belgrade_botanical_garden").scrapeActive,
    },
    {
      aliases: [
        "Botanical Garden Jevremovac",
        "Jevremovac Botanical Garden",
        "Botaničkoj bašti Jevremovac",
        "Jevremovac",
      ],
      category: "venue",
      location: "Takovska 43, Beograd",
      name: "Botanička bašta Jevremovac",
      publicStatus: "published",
      scrapeActive: false,
    },
  );
  assert.ok(
    !venuesByHandle
      .get("belgrade_botanical_garden")
      .aliases.some(
        (alias) =>
          normalizeVenueComparableText(alias) ===
          normalizeVenueComparableText("Botanička Bašta"),
      ),
    "The generic Botanical Garden alias must not be claimed globally.",
  );
  for (const venue of venuesByHandle.values()) {
    const identities = [...state.tables.venueIdentities.values()].filter(
      (identity) => identity.venueId === venue._id,
    );
    assert.ok(identities.every((identity) => identity.active === true));
    assert.ok(
      identities.every((identity) => identity.source === "venue_record"),
    );
    assert.equal(
      identities.filter((identity) => identity.kind === "provider_account")
        .length,
      1,
    );
  }
  const venueSnapshot = buildConvexVenueSnapshot(
    [...state.tables.venues.values()],
    [...state.tables.venueIdentities.values()],
  );
  for (const [variant, expectedHandle] of [
    ["Vinarija Zvonko Bogdan Palic", "vinarijazvonkobogdan"],
    ["Botanička bašta “Jevremovac”", "belgrade_botanical_garden"],
    ["Botanicka basta Jevremovac", "belgrade_botanical_garden"],
  ]) {
    const resolution = resolveVenueFromSnapshot(venueSnapshot, variant);
    assert.equal(
      resolution.resolution.status,
      "resolved",
      `${variant} must resolve through universal normalization without a redundant alias.`,
    );
    assert.equal(
      resolution.venueFields.venueInstagramHandle,
      expectedHandle,
    );
  }
  const progress = [...state.tables.eventDomainMigrationState.values()][0];
  assert.equal(
    progress.key,
    REVIEWED_OFFICIAL_VENUE_DIRECTORY_ADDITIONS_KEY,
  );
  assert.equal(progress.attempt, 1);
  assert.equal(progress.mismatchCount, 0);
  assert.ok(progress.completedAt);
  assert.deepEqual(JSON.parse(progress.auditDetailsJson), {
    handles: ["vinarijazvonkobogdan", "belgrade_botanical_garden"],
    issues: [],
    state: "post_apply",
  });

  const verified = await addReviewedOfficialVenueDirectoryEntries._handler(
    { db: state.db },
    { cursor: null, dryRun: true, limit: 2 },
  );
  assert.deepEqual(
    {
      mismatchCount: verified.mismatchCount,
      unchangedCount: verified.unchangedCount,
      updatedCount: verified.updatedCount,
    },
    { mismatchCount: 0, unchangedCount: 2, updatedCount: 0 },
  );
  assert.equal(state.tables.venueAuditLog.size, 2);

  const restarted = await addReviewedOfficialVenueDirectoryEntries._handler(
    { db: state.db },
    { cursor: null, dryRun: false, limit: 2, restart: true },
  );
  assert.deepEqual(
    {
      mismatchCount: restarted.mismatchCount,
      unchangedCount: restarted.unchangedCount,
      updatedCount: restarted.updatedCount,
    },
    { mismatchCount: 0, unchangedCount: 2, updatedCount: 0 },
  );
  assert.equal(state.tables.venues.size, 2);
  assert.equal(state.tables.venueIdentities.size, 11);
  assert.equal(state.tables.venueAuditLog.size, 2);
  assert.equal(
    [...state.tables.eventDomainMigrationState.values()][0].attempt,
    2,
  );
}

{
  const conflictFixtures = [
    {
      label: "provider identity owned by another venue",
      initial: {
        venueIdentities: [
          {
            _id: "conflicting_official_handle_identity",
            active: true,
            kind: "provider_account",
            normalizedValue: "vinarijazvonkobogdan",
            provider: "instagram",
            rawValue: "vinarijazvonkobogdan",
            source: "manual",
            venueId: "unrelated_venue",
          },
        ],
        venues: [
          {
            _id: "unrelated_venue",
            aliases: [],
            instagramHandle: "unrelated_venue",
            name: "Unrelated Venue",
            normalizedInstagramHandle: "unrelated_venue",
          },
        ],
      },
    },
    {
      label: "precise name alias owned by another venue",
      initial: {
        venues: [
          {
            _id: "conflicting_name_venue",
            aliases: ["Jevremovac"],
            instagramHandle: "different_botanical_account",
            name: "Different Venue",
            normalizedInstagramHandle: "different_botanical_account",
          },
        ],
      },
    },
    {
      label: "precise name identity owned under another identity kind",
      initial: {
        venueIdentities: [
          {
            _id: "conflicting_cross_kind_name_identity",
            active: true,
            kind: "historical_alias",
            normalizedValue: "jevremovac",
            rawValue: "Jevremovac",
            source: "manual",
            venueId: "cross_kind_owner",
          },
        ],
        venues: [
          {
            _id: "cross_kind_owner",
            aliases: [],
            instagramHandle: "cross_kind_owner",
            name: "Cross-kind Owner",
            normalizedInstagramHandle: "cross_kind_owner",
          },
        ],
      },
    },
    {
      label: "precise name claim owned as a provider account",
      initial: {
        venueIdentities: [
          {
            _id: "conflicting_provider_for_name_claim",
            active: true,
            kind: "provider_account",
            normalizedValue: "jevremovac",
            provider: "instagram",
            rawValue: "jevremovac",
            source: "manual",
            venueId: "provider_name_owner",
          },
        ],
        venues: [
          {
            _id: "provider_name_owner",
            aliases: [],
            instagramHandle: "provider_name_owner",
            name: "Provider Name Owner",
            normalizedInstagramHandle: "provider_name_owner",
          },
        ],
      },
    },
    {
      label: "official provider handle owned as a name identity",
      initial: {
        venueIdentities: [
          {
            _id: "conflicting_name_for_provider_claim",
            active: true,
            kind: "historical_alias",
            normalizedValue: "vinarijazvonkobogdan",
            rawValue: "vinarijazvonkobogdan",
            source: "manual",
            venueId: "name_provider_owner",
          },
        ],
        venues: [
          {
            _id: "name_provider_owner",
            aliases: [],
            instagramHandle: "name_provider_owner",
            name: "Name Provider Owner",
            normalizedInstagramHandle: "name_provider_owner",
          },
        ],
      },
    },
    {
      label: "reviewed handle has more than one venue row",
      initial: {
        venues: [
          {
            _id: "duplicate_handle_1",
            aliases: [],
            instagramHandle: "belgrade_botanical_garden",
            name: "First Duplicate",
            normalizedInstagramHandle: "belgrade_botanical_garden",
          },
          {
            _id: "duplicate_handle_2",
            aliases: [],
            instagramHandle: "@belgrade_botanical_garden",
            name: "Second Duplicate",
            normalizedInstagramHandle: "belgrade_botanical_garden",
          },
        ],
      },
    },
  ];
  for (const fixture of conflictFixtures) {
    const state = makeDb(fixture.initial);
    const venueSnapshot = structuredClone([...state.tables.venues.values()]);
    const identitySnapshot = structuredClone([
      ...state.tables.venueIdentities.values(),
    ]);
    const result = await addReviewedOfficialVenueDirectoryEntries._handler(
      { db: state.db },
      { cursor: null, dryRun: false, limit: 2 },
    );
    assert.ok(
      result.mismatchCount > 0,
      `${fixture.label} must block the reviewed migration.`,
    );
    assert.equal(result.updatedCount, 0);
    assert.deepEqual([...state.tables.venues.values()], venueSnapshot);
    assert.deepEqual(
      [...state.tables.venueIdentities.values()],
      identitySnapshot,
    );
    assert.equal(state.tables.venueAuditLog.size, 0);
    const progress = [...state.tables.eventDomainMigrationState.values()][0];
    assert.equal(progress.completedAt, undefined);
    assert.ok(progress.mismatchCount > 0);
  }
}

{
  const state = makeDb();
  await addReviewedOfficialVenueDirectoryEntries._handler(
    { db: state.db },
    { cursor: null, dryRun: false, limit: 2 },
  );
  state.tables.eventDomainMigrationState.clear();
  const winery = [...state.tables.venues.values()].find(
    (venue) => venue.instagramHandle === "vinarijazvonkobogdan",
  );
  state.tables.venues.delete(winery._id);
  for (const identity of [...state.tables.venueIdentities.values()]) {
    if (identity.venueId === winery._id) {
      state.tables.venueIdentities.delete(identity._id);
    }
  }
  for (const audit of [...state.tables.venueAuditLog.values()]) {
    if (audit.venueId === winery._id) state.tables.venueAuditLog.delete(audit._id);
  }
  const venueCountBefore = state.tables.venues.size;
  const result = await addReviewedOfficialVenueDirectoryEntries._handler(
    { db: state.db },
    { cursor: null, dryRun: false, limit: 2 },
  );
  assert.ok(result.mismatchCount > 0);
  assert.equal(result.updatedCount, 0);
  assert.equal(
    state.tables.venues.size,
    venueCountBefore,
    "Mixed pre/post state must not partially recreate a reviewed venue.",
  );
}

{
  const seedVenues = LEGACY_VENUE_ALIAS_SEEDS.map((seed, index) => ({
    _id: `seed_venue_${index}`,
    aliases: [],
    instagramHandle: seed.canonicalHandle,
    name: `Seed venue ${index}`,
    normalizedInstagramHandle: seed.canonicalHandle,
  }));
  const state = makeDb({ venues: seedVenues });
  const dryRun = await auditVenueCompatibilitySeeds._handler(
    { db: state.db },
    { dryRun: true },
  );
  assert.equal(dryRun.scannedCount, LEGACY_VENUE_ALIAS_SEEDS.length);
  assert.equal(dryRun.issueCount, 0);
  assert.equal(state.tables.eventDomainMigrationState.size, 0);
  const applied = await auditVenueCompatibilitySeeds._handler(
    { db: state.db },
    { dryRun: false },
  );
  assert.equal(applied.issueCount, 0);
  const auditState = [...state.tables.eventDomainMigrationState.values()][0];
  assert.equal(auditState.key, VENUE_COMPATIBILITY_SEED_AUDIT_KEY);
  assert.equal(auditState.auditDetailsJson, "[]");
  assert.ok(auditState.completedAt);
  await auditVenueCompatibilitySeeds._handler(
    { db: state.db },
    { dryRun: false },
  );
  assert.equal(
    state.tables.eventDomainMigrationState.size,
    1,
    "A stable seed audit rerun must be idempotent.",
  );

  const missingState = makeDb({ venues: seedVenues.slice(1) });
  const missing = await auditVenueCompatibilitySeeds._handler(
    { db: missingState.db },
    { dryRun: false },
  );
  assert.equal(missing.issueCount, 1);
  assert.match(missing.issuesJson, /missing_target/u);
  assert.equal(
    [...missingState.tables.eventDomainMigrationState.values()][0].completedAt,
    undefined,
    "A missing compatibility-seed target must keep the migration gate closed.",
  );

  const conflictState = makeDb({
    venues: [
      ...seedVenues,
      {
        _id: "ordinary_conflicting_venue",
        aliases: [],
        instagramHandle: "ordinary_conflicting_venue",
        isActive: true,
        name: LEGACY_VENUE_ALIAS_SEEDS[0].aliases[0],
      },
    ],
  });
  const conflict = await auditVenueCompatibilitySeeds._handler(
    { db: conflictState.db },
    { dryRun: false },
  );
  assert.equal(conflict.issueCount, 1);
  assert.match(conflict.issuesJson, /ordinary_claim_conflict/u);
  assert.equal(
    [...conflictState.tables.eventDomainMigrationState.values()][0].completedAt,
    undefined,
    "An ordinary venue-record owner must block a conflicting compatibility seed before writes.",
  );
}

{
  const state = makeCanonicalPayloadMigrationState();
  const occurrenceBefore = structuredClone(
    state.tables.sourceOccurrences.get("payload_occurrence"),
  );
  const receiptBefore = structuredClone(
    state.tables.instagramSourceOccurrenceReceipts.get("payload_receipt"),
  );
  await assertAdditiveIdempotentMigration({
    assertApplied() {
      const occurrence = state.tables.sourceOccurrences.get(
        "payload_occurrence",
      );
      const receipt = state.tables.instagramSourceOccurrenceReceipts.get(
        "payload_receipt",
      );
      const occurrencePayload = parseCanonicalEventPayload(
        occurrence.canonicalEventJson,
      );
      assert.ok(occurrencePayload);
      assert.equal(occurrencePayload.requestedStatus, "approved");
      assert.equal(occurrencePayload.description, "Exact QA description");
      assert.equal(occurrencePayload.ticketPrice, "1200 RSD");
      assert.equal(occurrencePayload.timeSource, "poster");
      assert.equal(
        receipt.expectedOccurrences[0].canonicalEventJson,
        occurrence.canonicalEventJson,
        "Occurrence and compatibility receipt must receive one exact payload atomically.",
      );
      assert.ok(occurrence.updatedAt > occurrenceBefore.updatedAt);
      assert.ok(receipt.updatedAt > receiptBefore.updatedAt);
      const topologyRows = [
        ...state.tables.sourceOccurrenceTopologyEpoch.values(),
      ];
      assert.equal(topologyRows.length, 1);
      assert.ok(
        topologyRows[0].currentEpoch > topologyRows[0].verifiedEpoch,
        "Payload materialization must dirty the topology epoch until the successor full audit.",
      );
      const progress = [
        ...state.tables.eventDomainMigrationState.values(),
      ][0];
      assert.equal(
        progress.key,
        "source-occurrence-canonical-payload-v1",
      );
      assert.ok(progress.completedAt);
    },
    assertDryRun() {
      assert.deepEqual(
        state.tables.sourceOccurrences.get("payload_occurrence"),
        occurrenceBefore,
      );
      assert.deepEqual(
        state.tables.instagramSourceOccurrenceReceipts.get("payload_receipt"),
        receiptBefore,
      );
    },
    expectedUpdates: 1,
    label: "source-occurrence canonical payload",
    mutation: backfillSourceOccurrenceCanonicalPayloadsBatch,
    state,
  });
}

{
  const state = makeCanonicalPayloadMigrationState();
  state.tables.scrapedPosts.get("payload_document").analysisResultJson =
    JSON.stringify({ contract_version: "event_evidence_v2", is_event: false });
  const result = await backfillSourceOccurrenceCanonicalPayloadsBatch._handler(
    { db: state.db },
    { cursor: null, dryRun: false, limit: 25 },
  );
  assert.equal(result.updatedCount, 0);
  assert.equal(result.mismatchCount, 1);
  assert.equal(
    state.tables.sourceOccurrences.get("payload_occurrence")
      .canonicalEventJson,
    undefined,
    "Drifted immutable extraction bytes must not be blessed into a canonical payload.",
  );
  const progress = [...state.tables.eventDomainMigrationState.values()][0];
  assert.equal(progress.completedAt, undefined);
  assert.match(progress.auditDetailsJson, /attested_binding_drifted/u);
}

{
  const state = makeDb({
    eventDomainMigrationState: [cleanVenueCompatibilitySeedAuditState()],
    venues: [
      {
        _id: "venue_hidden_duplicate",
        aliases: ["Retired Alias"],
        instagramHandle: "retired_venue",
        isActive: false,
        name: "Retired Venue",
        publicStatus: "hidden",
        scrapeActive: false,
      },
    ],
  });
  const result = await backfillVenueIdentitiesBatch._handler(
    { db: state.db },
    { cursor: null, dryRun: false, limit: 25 },
  );
  assert.equal(result.mismatchCount, 0);
  assert.equal(result.scannedCount, 1);
  assert.equal(result.updatedCount, 0);
  assert.equal(
    state.tables.venueIdentities.size,
    0,
    "Hidden duplicate venues must not be reactivated by the identity backfill.",
  );
}

{
  const state = makeDb({
    scrapedPosts: [
      {
        _id: "post_1",
        handle: "qa_venue",
        imageUrls: [],
        instagramPostUrl:
          "https://instagram.com/reel/CanonicalPost1/?utm_source=qa",
        postId: "CanonicalPost1",
        username: "qa_venue",
      },
    ],
  });
  await assertAdditiveIdempotentMigration({
    assertApplied() {
      assert.equal(
        state.tables.scrapedPosts.get("post_1").canonicalSourceUrl,
        "https://www.instagram.com/p/CanonicalPost1/",
      );
    },
    assertDryRun() {
      assert.equal(
        state.tables.scrapedPosts.get("post_1").canonicalSourceUrl,
        undefined,
      );
    },
    expectedUpdates: 1,
    label: "source URL",
    mutation: backfillSourceDocumentCanonicalUrlsBatch,
    state,
  });
}

function legacyInstagramProfileSnapshotFixture(overrides = {}) {
  const handle = overrides.handle ?? "legacy_profile";
  const postId = overrides.postId ?? "123456789";
  return {
    _creationTime: 1_783_144_930_135,
    _id: overrides._id ?? "legacy_profile_snapshot",
    blocksPaidFetch: false,
    createdAt: 1_783_144_930_135,
    handle,
    imageUrls: [],
    instagramPostUrl: `https://www.instagram.com/${handle}`,
    lastProcessedAt: 1_784_353_696_274,
    postId,
    processingAttempts: 1,
    processingOutcome: "terminal_no_event",
    processingStatus: "completed",
    sourceKey: `${handle}:${postId}`,
    updatedAt: 1_784_353_696_274,
    username: handle,
    ...overrides,
  };
}

{
  const firstLegacySnapshot = legacyInstagramProfileSnapshotFixture({
    _id: "legacy_profile_snapshot_1",
  });
  const secondLegacySnapshot = legacyInstagramProfileSnapshotFixture({
    _id: "legacy_profile_snapshot_2",
    handle: "legacy.profile.two",
    instagramPostUrl: "https://www.instagram.com/legacy.profile.two",
    postId: "987654321",
    sourceKey: "legacy.profile.two:987654321",
    username: "legacy.profile.two",
  });
  const state = makeDb({
    scrapedPosts: [firstLegacySnapshot, secondLegacySnapshot],
  });
  const dryRun = await backfillSourceDocumentCanonicalUrlsBatch._handler(
    { db: state.db },
    { cursor: null, dryRun: true, limit: 1 },
  );
  assert.equal(dryRun.mismatchCount, 0);
  assert.equal(dryRun.skippedCount, 1);
  assert.equal(dryRun.updatedCount, 0);
  assert.equal(state.tables.eventDomainMigrationState.size, 0);

  const firstPage = await backfillSourceDocumentCanonicalUrlsBatch._handler(
    { db: state.db },
    { cursor: null, dryRun: false, limit: 1 },
  );
  assert.equal(firstPage.isDone, false);
  assert.equal(firstPage.skippedCount, 1);
  const secondPage = await backfillSourceDocumentCanonicalUrlsBatch._handler(
    { db: state.db },
    { cursor: firstPage.continueCursor, dryRun: false, limit: 1 },
  );
  assert.equal(secondPage.isDone, true);
  assert.equal(secondPage.skippedCount, 1);
  const progress = [
    ...state.tables.eventDomainMigrationState.values(),
  ][0];
  assert.ok(progress.completedAt);
  assert.equal(progress.mismatchCount, 0);
  assert.equal(progress.scannedCount, 2);
  assert.equal(progress.skippedCount, 2);
  assert.deepEqual(JSON.parse(progress.skipReasonCountsJson), {
    legacy_instagram_profile_snapshot: 2,
  });
  assert.deepEqual(JSON.parse(progress.auditDetailsJson), {
    legacyProfileSnapshotPolicy:
      "exact-pre-2026-08-instagram-profile-snapshot-v1",
  });
  assert.deepEqual(
    state.tables.scrapedPosts.get(firstLegacySnapshot._id),
    firstLegacySnapshot,
    "Legacy profile snapshots must remain byte-for-byte unchanged.",
  );
  await backfillSourceDocumentCanonicalUrlsBatch._handler(
    { db: state.db },
    { cursor: null, dryRun: false, limit: 25, restart: true },
  );
  const restartedProgress = [
    ...state.tables.eventDomainMigrationState.values(),
  ][0];
  assert.equal(restartedProgress.attempt, 2);
  assert.equal(restartedProgress.skippedCount, 2);
  assert.deepEqual(JSON.parse(restartedProgress.skipReasonCountsJson), {
    legacy_instagram_profile_snapshot: 2,
  });
}

{
  const state = makeDb({
    scrapedPosts: [
      legacyInstagramProfileSnapshotFixture({
        _id: "exact_legacy_profile_snapshot",
      }),
      legacyInstagramProfileSnapshotFixture({
        _id: "profile_with_post_evidence",
        caption: "Real post evidence must never be silently quarantined.",
      }),
      legacyInstagramProfileSnapshotFixture({
        _id: "profile_after_legacy_cutoff",
        createdAt: Date.UTC(2026, 7, 2),
      }),
      {
        _id: "ordinary_malformed_source",
        handle: "qa",
        imageUrls: [],
        instagramPostUrl: "not-an-instagram-url",
        postId: "Malformed",
        username: "qa",
      },
    ],
  });
  const result = await backfillSourceDocumentCanonicalUrlsBatch._handler(
    { db: state.db },
    { cursor: null, dryRun: true, limit: 25 },
  );
  assert.equal(result.mismatchCount, 3);
  assert.equal(result.skippedCount, 1);
  assert.equal(result.updatedCount, 0);
}

{
  const ordinaryExpected = {
    artists: ["Ordinary Artist"],
    date: "2026-09-12",
    key: "ordinary-occurrence-key",
    time: "20:00",
    title: "Ordinary Event",
    venue: "Ordinary Venue",
  };
  const campaignLink = {
    _id: "campaign_source_link",
    eventId: "campaign_event",
    instagramPostId: "CampaignPost",
    instagramPostUrl: "https://www.instagram.com/p/CampaignPost/",
    sourceFingerprint: "campaign-fingerprint",
    sourceHandle: "campaign_venue",
    sourceIdentity: "campaign-source-identity",
    sourceOccurrenceKey: "campaign-occurrence-key",
    updatedAt: 44,
  };
  const state = makeDb({
    events: [
      {
        _id: "ordinary_event",
        artists: ordinaryExpected.artists,
        date: ordinaryExpected.date,
        eventType: "concert",
        normalizedFieldsJson: JSON.stringify({
          sourceOccurrenceSourceFingerprint: "ordinary-fingerprint",
        }),
        rawExtractionJson: JSON.stringify({ is_event: true }),
        sourceOccurrenceKey: ordinaryExpected.key,
        status: "approved",
        time: ordinaryExpected.time,
        title: ordinaryExpected.title,
        updatedAt: 33,
        venue: ordinaryExpected.venue,
      },
      {
        _id: "campaign_event",
        artists: ["Campaign Artist"],
        date: "2026-09-12",
        eventType: "nightlife",
        moderationNote: "[cross_post_campaign_variant:v2] audited fixture",
        sourceOccurrenceKey: campaignLink.sourceOccurrenceKey,
        status: "rejected",
        time: "22:00",
        title: "Campaign Variant",
        updatedAt: 44,
        venue: "Campaign Venue",
      },
    ],
    instagramEventSources: [
      {
        _id: "ordinary_source_link",
        eventId: "ordinary_event",
        instagramPostId: "OrdinaryPost",
        instagramPostUrl: "https://www.instagram.com/p/OrdinaryPost/",
        sourceFingerprint: "ordinary-fingerprint",
        sourceHandle: "ordinary_venue",
        sourceIdentity: "ordinary-source-identity",
        sourceOccurrenceKey: ordinaryExpected.key,
        updatedAt: 33,
      },
      campaignLink,
    ],
    instagramSourceOccurrenceReceipts: [
      {
        _id: "ordinary_receipt",
        deferredChildCount: 0,
        deferredChildKeys: [],
        expectedKeys: [ordinaryExpected.key],
        expectedOccurrences: [ordinaryExpected],
        satisfiedKeys: [ordinaryExpected.key],
        satisfiedOccurrences: [
          { eventId: "ordinary_event", key: ordinaryExpected.key },
        ],
        sourceFingerprint: "ordinary-fingerprint",
        sourceIdentity: "ordinary-source-identity",
      },
    ],
    scrapedPosts: [
      {
        _id: "ordinary_document",
        handle: "ordinary_venue",
        imageUrls: [],
        instagramPostUrl: "https://www.instagram.com/p/OrdinaryPost/",
        postId: "OrdinaryPost",
        processingStatus: "completed",
        sourceRevision: 1,
        analysisRevision: 1,
        analysisResultJson: JSON.stringify({ is_event: true }),
        username: "ordinary_venue",
      },
    ],
  });
  const campaignLinkBefore = structuredClone(
    state.tables.instagramEventSources.get(campaignLink._id),
  );
  const result = await backfillSourceOccurrencesBatch._handler(
    { db: state.db },
    { cursor: null, dryRun: false, limit: 25 },
  );
  assert.equal(result.scannedCount, 2);
  assert.equal(result.updatedCount, 1);
  assert.equal(result.skippedCount, 1);
  assert.equal(result.quarantinedLineageMarkerCount, 1);
  assert.equal(result.mismatchCount, 0);
  assert.deepEqual(
    state.tables.instagramEventSources.get(campaignLink._id),
    campaignLinkBefore,
    "Generic occurrence migration must leave audited lineage links byte-for-byte unchanged.",
  );
  const progress = [...state.tables.eventDomainMigrationState.values()][0];
  assert.equal(progress.key, "source-occurrences-generic-v2");
  assert.equal(progress.skippedCount, 1);
  assert.equal(progress.quarantinedLineageMarkerCount, 1);
  assert.ok(
    progress.completedAt,
    "Intentional lineage quarantine must not block scoped v2 readiness.",
  );
}

{
  const state = makeDb({
    mediaAssets: [
      {
        _id: "media_1",
        normalizedInstagramPostUrl:
          "https://www.instagram.com/tv/CanonicalPost2/",
      },
    ],
  });
  await assertAdditiveIdempotentMigration({
    assertApplied() {
      assert.equal(
        state.tables.mediaAssets.get("media_1").canonicalSourceUrl,
        "https://www.instagram.com/p/CanonicalPost2/",
      );
    },
    expectedUpdates: 1,
    label: "media URL",
    mutation: backfillMediaCanonicalUrlsBatch,
    state,
  });
}

{
  const existingAliases = Array.from({ length: 50 }, (_, index) => ({
    _id: `capped_alias_${index}`,
    active: true,
    kind: "alias",
    normalizedValue: `existing alias ${index}`,
    rawValue: `Existing Alias ${index}`,
    source: "migration",
    venueId: "venue_cap",
  }));
  const state = makeDb({
    eventDomainMigrationState: [cleanVenueCompatibilitySeedAuditState()],
    venueIdentities: existingAliases,
    venues: [
      {
        _id: "venue_cap",
        aliases: [
          ...Array.from(
            { length: 49 },
            (_, index) => `Existing Alias ${index}`,
          ),
          "New Alias A",
          "New Alias B",
        ],
        instagramHandle: "",
        name: "Capacity Venue",
      },
    ],
  });
  const result = await backfillVenueIdentitiesBatch._handler(
    { db: state.db },
    { cursor: null, dryRun: false, limit: 25 },
  );
  assert.equal(result.mismatchCount, 1);
  assert.equal(result.updatedCount, 0);
  assert.equal(state.tables.venueIdentities.size, 50);
  assert.ok(
    [...state.tables.venueIdentities.values()].every(
      (identity) => identity.source === "migration",
    ),
    "Venue identity overflow must be detected before any insert or source promotion.",
  );
}

{
  const state = makeDb({
    eventDomainMigrationState: [
      {
        _id: "venue_identity_ready_for_invalid_unresolved",
        completedAt: 1,
        cursor: "2",
        errorCount: 0,
        isDone: true,
        key: "venue-identities-v1",
        mismatchCount: 0,
        phase: "venue_identities",
        scannedCount: 2,
        updatedAt: 1,
        updatedCount: 2,
      },
    ],
    events: [
      {
        _id: "event_empty_unresolved_venue",
        artists: [],
        date: "2026-09-23",
        eventType: "event",
        status: "pending",
        title: "Missing Venue Claim",
        updatedAt: 94,
        venue: "",
      },
      {
        _id: "event_bound_but_unresolved_venue",
        artists: [],
        date: "2026-09-24",
        eventType: "event",
        normalizedVenueIdentity: "legacy bound hall",
        status: "approved",
        title: "Bound Venue Must Survive",
        updatedAt: 95,
        venue: "Legacy Bound Hall",
        venueId: "bound_venue_without_identity",
      },
    ],
    venues: [
      {
        _id: "bound_venue_without_identity",
        aliases: [],
        category: "venue",
        instagramHandle: "bound_venue_without_identity",
        name: "Bound Venue Without Identity",
        publicStatus: "published",
        scrapeActive: false,
      },
    ],
  });
  const before = structuredClone([...state.tables.events.values()]);
  const result = await backfillEventVenueBindingsBatch._handler(
    { db: state.db },
    { cursor: null, dryRun: false, limit: 25 },
  );
  assert.equal(result.mismatchCount, 2);
  assert.equal(result.updatedCount, 0);
  assert.deepEqual(
    [...state.tables.events.values()],
    before,
    "An empty unresolved claim or stale resolver state must never clear an existing canonical venue binding.",
  );
  const progress = [...state.tables.eventDomainMigrationState.values()].find(
    (row) => row.key === "event-venue-bindings-v1",
  );
  assert.equal(progress.completedAt, undefined);
  assert.equal(isCompleteEventVenueBindingCoverage(progress), false);
}

{
  const state = makeDb({
    eventDomainMigrationState: [
      {
        _id: "venue_identity_ready",
        completedAt: 1,
        cursor: "1",
        errorCount: 0,
        isDone: true,
        key: "venue-identities-v1",
        mismatchCount: 0,
        phase: "venue_identities",
        scannedCount: 1,
        updatedAt: 1,
        updatedCount: 1,
      },
    ],
    events: [
      {
        _id: "event_venue_binding",
        artists: ["Bound Artist"],
        date: "2026-09-15",
        eventType: "concert",
        status: "pending",
        time: "20:00",
        title: "Bound Venue Event",
        updatedAt: 91,
        venue: "QA Hall",
      },
    ],
    venueIdentities: [
      {
        _id: "venue_alias_identity",
        active: true,
        kind: "alias",
        normalizedValue: "qa hall",
        rawValue: "QA Hall",
        source: "venue_record",
        venueId: "venue_binding_target",
      },
    ],
    venues: [
      {
        _id: "venue_binding_target",
        aliases: ["QA Hall"],
        category: "club",
        instagramHandle: "qa_venue",
        name: "QA Venue",
        publicStatus: "published",
        scrapeActive: true,
      },
    ],
  });
  const dryRun = await backfillEventVenueBindingsBatch._handler(
    { db: state.db },
    { cursor: null, dryRun: true, limit: 25 },
  );
  assert.equal(dryRun.updatedCount, 1);
  assert.equal(
    state.tables.events.get("event_venue_binding").venueId,
    undefined,
  );
  const applied = await backfillEventVenueBindingsBatch._handler(
    { db: state.db },
    { cursor: null, dryRun: false, limit: 25 },
  );
  assert.equal(applied.updatedCount, 1);
  const event = state.tables.events.get("event_venue_binding");
  assert.equal(event.venueId, "venue_binding_target");
  assert.equal(event.occurrenceVenueIdentity, "id:venue_binding_target");
  assert.equal(
    event.updatedAt,
    91,
    "Venue binding migration must preserve event version.",
  );
  const progress = [...state.tables.eventDomainMigrationState.values()].find(
    (row) => row.key === "event-venue-bindings-v1",
  );
  assert.ok(progress?.completedAt);
}

{
  const alreadyNormalized = {
    _id: "event_unresolved_unchanged",
    artists: ["Independent Artist"],
    date: "2026-09-21",
    eventType: "concert",
    normalizedVenueIdentity: "independent garden",
    status: "pending",
    time: "20:00",
    title: "Independent Garden Event",
    updatedAt: 92,
    venue: "Independent Garden",
  };
  const state = makeDb({
    eventDomainMigrationState: [
      {
        _id: "venue_identity_ready_for_unresolved",
        completedAt: 1,
        cursor: "1",
        errorCount: 0,
        isDone: true,
        key: "venue-identities-v1",
        mismatchCount: 0,
        phase: "venue_identities",
        scannedCount: 1,
        updatedAt: 1,
        updatedCount: 1,
      },
    ],
    events: [
      {
        ...alreadyNormalized,
        ...buildEventOccurrenceIndexPatch(alreadyNormalized),
      },
      {
        _id: "event_unresolved_needs_normalization",
        artists: [],
        date: "2026-09-22",
        eventType: "nightlife",
        status: "approved",
        time: "TBD",
        title: "Unknown Directory Venue Event",
        updatedAt: 93,
        venue: "Unknown Directory Venue",
      },
      {
        _id: "event_styled_unresolved_needs_normalization",
        artists: [],
        date: "2026-09-23",
        eventType: "event",
        status: "rejected",
        time: "TBD",
        title: "Styled Unknown Directory Venue Event",
        updatedAt: 94,
        venue: "𝗦𝗠𝗣",
      },
    ],
  });
  const dryRun = await backfillEventVenueBindingsBatch._handler(
    { db: state.db },
    { cursor: null, dryRun: true, limit: 25 },
  );
  assert.equal(dryRun.mismatchCount, 0);
  assert.equal(dryRun.unchangedCount, 1);
  assert.equal(dryRun.updatedCount, 2);
  assert.equal(
    state.tables.events.get("event_unresolved_needs_normalization")
      .normalizedVenueIdentity,
    undefined,
    "Unresolved venue dry-run must remain read-only.",
  );

  const applied = await backfillEventVenueBindingsBatch._handler(
    { db: state.db },
    { cursor: null, dryRun: false, limit: 25 },
  );
  assert.equal(applied.mismatchCount, 0);
  assert.equal(applied.updatedCount, 2);
  const normalized = state.tables.events.get(
    "event_unresolved_needs_normalization",
  );
  assert.equal(normalized.venueId, undefined);
  assert.equal(
    normalized.normalizedVenueIdentity,
    "unknown directory venue",
  );
  assert.equal(
    normalized.occurrenceVenueIdentity,
    "name:unknown directory venue",
  );
  const styledNormalized = state.tables.events.get(
    "event_styled_unresolved_needs_normalization",
  );
  assert.equal(styledNormalized.venueId, undefined);
  assert.equal(styledNormalized.normalizedVenueIdentity, "smp");
  assert.equal(styledNormalized.occurrenceVenueIdentity, "name:smp");
  const progress = [...state.tables.eventDomainMigrationState.values()].find(
    (row) => row.key === "event-venue-bindings-v1",
  );
  assert.ok(
    progress?.completedAt,
    "Explicit unresolved venue coverage must complete cleanly without inventing a venue record.",
  );
  assert.equal(
    isCompleteEventVenueBindingCoverage(progress),
    true,
    "Explicit unresolved rows must count as audited zero-exception coverage.",
  );

  const verified = await backfillEventVenueBindingsBatch._handler(
    { db: state.db },
    { cursor: null, dryRun: true, limit: 25 },
  );
  assert.equal(verified.mismatchCount, 0);
  assert.equal(verified.unchangedCount, 3);
  assert.equal(verified.updatedCount, 0);

  const restarted = await backfillEventVenueBindingsBatch._handler(
    { db: state.db },
    { cursor: null, dryRun: false, limit: 25, restart: true },
  );
  assert.equal(restarted.mismatchCount, 0);
  assert.equal(restarted.unchangedCount, 3);
  assert.equal(restarted.updatedCount, 0);
  const restartedProgress = [...state.tables.eventDomainMigrationState.values()].find(
    (row) => row.key === "event-venue-bindings-v1",
  );
  assert.equal(restartedProgress.attempt, 2);
  assert.ok(restartedProgress.completedAt);
  assert.equal(isCompleteEventVenueBindingCoverage(restartedProgress), true);

  for (const unsafePatch of [
    { mismatchCount: 1 },
    { errorCount: 1 },
    { skippedCount: 1 },
    { quarantinedLineageMarkerCount: 1 },
  ]) {
    assert.equal(
      isCompleteEventVenueBindingCoverage({
        ...restartedProgress,
        ...unsafePatch,
      }),
      false,
      "Publication/reconciliation readiness must remain fail-closed for unresolved migration exceptions.",
    );
  }
}

{
  const state = makeDb({
    eventDomainMigrationState: [
      {
        _id: "venue_identity_ready_for_ambiguity",
        completedAt: 1,
        cursor: "2",
        errorCount: 0,
        isDone: true,
        key: "venue-identities-v1",
        mismatchCount: 0,
        phase: "venue_identities",
        scannedCount: 2,
        updatedAt: 1,
        updatedCount: 2,
      },
    ],
    events: [
      {
        _id: "event_ambiguous_venue",
        artists: [],
        date: "2026-09-23",
        eventType: "event",
        status: "pending",
        title: "Ambiguous Venue Event",
        updatedAt: 94,
        venue: "Shared Hall",
      },
    ],
    venueIdentities: [
      {
        _id: "shared_hall_alias_a",
        active: true,
        kind: "alias",
        normalizedValue: "shared hall",
        rawValue: "Shared Hall",
        source: "venue_record",
        venueId: "shared_hall_a",
      },
      {
        _id: "shared_hall_alias_b",
        active: true,
        kind: "alias",
        normalizedValue: "shared hall",
        rawValue: "Shared Hall",
        source: "venue_record",
        venueId: "shared_hall_b",
      },
    ],
    venues: [
      {
        _id: "shared_hall_a",
        category: "club",
        instagramHandle: "shared_hall_a",
        name: "Shared Hall A",
        publicStatus: "published",
        scrapeActive: true,
      },
      {
        _id: "shared_hall_b",
        category: "club",
        instagramHandle: "shared_hall_b",
        name: "Shared Hall B",
        publicStatus: "published",
        scrapeActive: true,
      },
    ],
  });
  const result = await backfillEventVenueBindingsBatch._handler(
    { db: state.db },
    { cursor: null, dryRun: true, limit: 25 },
  );
  assert.equal(result.mismatchCount, 1);
  assert.equal(result.updatedCount, 0);
  assert.equal(
    state.tables.events.get("event_ambiguous_venue").venueId,
    undefined,
    "Ambiguous venue ownership must remain fail-closed.",
  );
}

{
  const expected = {
    artists: ["Proven Artist"],
    date: "2026-09-24",
    key: "unresolved-provenance-key",
    time: "21:00",
    title: "Unresolved Provenance Event",
    venue: "Evidence Garden",
  };
  const state = makeDb({
    eventDomainMigrationState: [
      {
        _id: "venue_identity_ready_for_unresolved_provenance",
        completedAt: 1,
        cursor: "1",
        errorCount: 0,
        isDone: true,
        key: "venue-identities-v1",
        mismatchCount: 0,
        phase: "venue_identities",
        scannedCount: 1,
        updatedAt: 1,
        updatedCount: 1,
      },
    ],
    events: [
      {
        _id: "event_unresolved_provenance",
        artists: expected.artists,
        date: expected.date,
        eventType: "concert",
        sourceOccurrenceKey: expected.key,
        status: "approved",
        time: expected.time,
        title: expected.title,
        updatedAt: 95,
        venue: expected.venue,
      },
    ],
    instagramEventSources: [
      {
        _id: "unresolved_provenance_link",
        eventId: "event_unresolved_provenance",
        sourceFingerprint: "unresolved-provenance-fingerprint",
        sourceIdentity: "unresolved-provenance-source",
        sourceOccurrenceId: "unresolved_provenance_occurrence",
        sourceOccurrenceKey: expected.key,
        updatedAt: 1,
      },
    ],
    instagramSourceOccurrenceReceipts: [
      {
        _id: "unresolved_provenance_receipt",
        deferredChildCount: 0,
        deferredChildKeys: [],
        expectedKeys: [expected.key],
        expectedOccurrences: [expected],
        satisfiedKeys: [expected.key],
        satisfiedOccurrences: [
          { eventId: "event_unresolved_provenance", key: expected.key },
        ],
        sourceFingerprint: "unresolved-provenance-fingerprint",
        sourceIdentity: "unresolved-provenance-source",
        updatedAt: 1,
      },
    ],
    sourceOccurrences: [
      {
        _id: "unresolved_provenance_occurrence",
        canonicalEventId: "event_unresolved_provenance",
        occurrenceArtistFingerprint: "proven artist",
        occurrenceDateKey: expected.date,
        occurrenceEventType: "concert",
        occurrenceSignatureHash: "stale-unresolved-signature",
        occurrenceSignatureVersion: 1,
        occurrenceTimeIdentity: "21:00",
        occurrenceTitleFamily: "unresolvedprovenanceevent",
        occurrenceVenueIdentity: "name:evidence garden",
        sourceFingerprint: "unresolved-provenance-fingerprint",
        sourceIdentity: "unresolved-provenance-source",
        sourceOccurrenceKey: expected.key,
        state: "satisfied",
        updatedAt: 1,
        venueResolutionStatus: "unresolved",
      },
    ],
  });
  const dryRun = await backfillEventVenueBindingsBatch._handler(
    { db: state.db },
    { cursor: null, dryRun: true, limit: 25 },
  );
  assert.equal(dryRun.mismatchCount, 0);
  assert.equal(dryRun.updatedCount, 1);
  assert.equal(
    state.tables.sourceOccurrences.get("unresolved_provenance_occurrence")
      .occurrenceSignatureHash,
    "stale-unresolved-signature",
    "Unresolved provenance dry-run must not mutate its occurrence.",
  );

  const applied = await backfillEventVenueBindingsBatch._handler(
    { db: state.db },
    { cursor: null, dryRun: false, limit: 25 },
  );
  assert.equal(applied.mismatchCount, 0);
  assert.equal(applied.updatedCount, 1);
  const event = state.tables.events.get("event_unresolved_provenance");
  const occurrence = state.tables.sourceOccurrences.get(
    "unresolved_provenance_occurrence",
  );
  const receipt = state.tables.instagramSourceOccurrenceReceipts.get(
    "unresolved_provenance_receipt",
  );
  assert.equal(event.normalizedVenueIdentity, "evidence garden");
  assert.equal(event.venueId, undefined);
  assert.equal(
    event.updatedAt,
    95,
    "Derived venue migration must preserve event version.",
  );
  assert.equal(occurrence.canonicalEventId, event._id);
  assert.equal(occurrence.venueId, undefined);
  assert.equal(occurrence.venueResolutionStatus, "unresolved");
  assert.equal(occurrence.occurrenceVenueIdentity, "name:evidence garden");
  assert.notEqual(
    occurrence.occurrenceSignatureHash,
    "stale-unresolved-signature",
  );
  assert.deepEqual(receipt.expectedOccurrences, [expected]);
  const topology = topologyEpochSnapshot(state);
  assert.ok(Number.isSafeInteger(topology?.currentEpoch));
  assert.equal(topology.currentEpoch, topology.verifiedEpoch);
}

{
  const expectedOccurrence = {
    artists: ["Stale Artist"],
    date: "2026-09-14",
    key: "stale-occurrence-key",
    time: "20:00",
    title: "Stale Poster Event",
    venue: "Stale Venue",
  };
  const state = makeDb({
    events: [
      {
        _id: "stale_event",
        artists: expectedOccurrence.artists,
        date: expectedOccurrence.date,
        eventType: "concert",
        normalizedFieldsJson: JSON.stringify({
          sourceOccurrenceSourceFingerprint: "same-caption-fingerprint",
        }),
        rawExtractionJson: JSON.stringify({ poster_version: 1 }),
        sourceOccurrenceKey: expectedOccurrence.key,
        status: "approved",
        time: expectedOccurrence.time,
        title: expectedOccurrence.title,
        updatedAt: 1,
        venue: expectedOccurrence.venue,
      },
    ],
    instagramEventSources: [
      {
        _id: "stale_link",
        eventId: "stale_event",
        instagramPostId: "StalePost",
        instagramPostUrl: "https://www.instagram.com/p/StalePost/",
        sourceFingerprint: "same-caption-fingerprint",
        sourceIdentity: "stale-source-identity",
        sourceOccurrenceKey: expectedOccurrence.key,
        updatedAt: 1,
      },
    ],
    instagramSourceOccurrenceReceipts: [
      {
        _id: "stale_receipt",
        deferredChildCount: 0,
        deferredChildKeys: [],
        expectedKeys: [expectedOccurrence.key],
        expectedOccurrences: [expectedOccurrence],
        satisfiedKeys: [expectedOccurrence.key],
        satisfiedOccurrences: [
          { eventId: "stale_event", key: expectedOccurrence.key },
        ],
        sourceFingerprint: "same-caption-fingerprint",
        sourceIdentity: "stale-source-identity",
      },
    ],
    scrapedPosts: [
      {
        _id: "stale_document",
        analysisResultJson: JSON.stringify({ poster_version: 2 }),
        analysisRevision: 2,
        handle: "stale_venue",
        imageUrls: [],
        instagramPostUrl: "https://www.instagram.com/p/StalePost/",
        postId: "StalePost",
        processingStatus: "completed",
        sourceRevision: 2,
        username: "stale_venue",
      },
    ],
  });
  const result = await backfillSourceOccurrencesBatch._handler(
    { db: state.db },
    { cursor: null, dryRun: false, limit: 25 },
  );
  assert.equal(result.updatedCount, 0);
  assert.equal(result.mismatchCount, 1);
  assert.equal(state.tables.sourceOccurrences.size, 0);
  const progress = [...state.tables.eventDomainMigrationState.values()][0];
  assert.equal(
    progress.completedAt,
    undefined,
    "A current source revision with different extraction bytes must block readiness.",
  );
}

{
  const state = makeDb({
    events: [
      {
        _id: "event_1",
        artists: ["QA Artist"],
        date: "2026-09-10",
        eventType: "concert",
        normalizedFieldsJson: JSON.stringify({
          sourceOccurrenceSourceFingerprint: "fingerprint-1",
        }),
        rawExtractionJson: JSON.stringify({ is_event: true }),
        instagramPostUrl: "https://www.instagram.com/reels/CanonicalPost3/",
        status: "pending",
        time: "20:00",
        title: "QA Event",
        updatedAt: 77,
        venue: "QA Venue",
      },
    ],
  });
  await assertAdditiveIdempotentMigration({
    assertApplied() {
      const event = state.tables.events.get("event_1");
      assert.equal(
        event.canonicalSourceUrl,
        "https://www.instagram.com/p/CanonicalPost3/",
      );
      assert.equal(event.occurrenceSignatureVersion, 1);
      assert.equal(event.publicationState, "hidden");
      assert.equal(
        event.updatedAt,
        77,
        "Derived-field migration must preserve event version.",
      );
    },
    expectedUpdates: 1,
    label: "canonical event fields",
    mutation: backfillCanonicalEventFieldsBatch,
    state,
  });
}

{
  const state = makeDb({
    eventDomainMigrationState: [cleanVenueCompatibilitySeedAuditState()],
    venues: [
      {
        _id: "venue_1",
        aliases: ["QA Hall", "QA Hall"],
        instagramHandle: "@qa_hall",
        name: "QA Venue",
      },
    ],
  });
  await assertAdditiveIdempotentMigration({
    assertApplied() {
      const identities = [...state.tables.venueIdentities.values()];
      assert.deepEqual(
        identities
          .map((identity) => [identity.kind, identity.normalizedValue])
          .sort(),
        [
          ["alias", "qa hall"],
          ["canonical_name", "qa venue"],
          ["provider_account", "qa_hall"],
        ],
      );
    },
    expectedUpdates: 3,
    label: "venue identities",
    mutation: backfillVenueIdentitiesBatch,
    state,
  });
}

{
  const state = makeDb({
    eventDomainMigrationState: [cleanVenueCompatibilitySeedAuditState()],
    venues: [
      {
        _id: "venue_legacy_seed",
        aliases: [],
        instagramHandle: "@freestylerbelgrade_official",
        name: "Freestyler Club",
      },
    ],
  });
  await assertAdditiveIdempotentMigration({
    assertApplied() {
      const identities = [...state.tables.venueIdentities.values()];
      const compatibilityAliases = Object.fromEntries(
        identities
          .filter((identity) => identity.kind === "alias")
          .map((identity) => [identity.normalizedValue, identity.source]),
      );
      assert.deepEqual(compatibilityAliases, {
        freestyler: "manual",
        "freestyler belgrade": "manual",
        "splav freestyler": "manual",
      });
      assert.equal(
        identities.find((identity) => identity.kind === "canonical_name")
          ?.source,
        "venue_record",
      );
      assert.equal(
        identities.find((identity) => identity.kind === "provider_account")
          ?.source,
        "venue_record",
      );
    },
    expectedUpdates: 5,
    label: "legacy compatibility venue aliases",
    mutation: backfillVenueIdentitiesBatch,
    state,
  });
}

{
  const expectedOccurrence = {
    artists: ["QA Artist"],
    date: "2026-09-11",
    key: "occurrence-key-1",
    time: "21:00",
    title: "QA Occurrence",
    venue: "QA Venue",
  };
  const state = makeDb({
    events: [
      {
        _id: "event_source_1",
        artists: expectedOccurrence.artists,
        date: expectedOccurrence.date,
        eventType: "concert",
        normalizedFieldsJson: JSON.stringify({
          sourceOccurrenceSourceFingerprint: "fingerprint-1",
        }),
        rawExtractionJson: JSON.stringify({ is_event: true }),
        sourceOccurrenceKey: expectedOccurrence.key,
        status: "pending",
        time: expectedOccurrence.time,
        title: expectedOccurrence.title,
        updatedAt: 88,
        venue: expectedOccurrence.venue,
      },
    ],
    instagramEventSources: [
      {
        _id: "source_link_1",
        eventId: "event_source_1",
        instagramPostId: "CanonicalPost4",
        instagramPostUrl: "https://www.instagram.com/p/CanonicalPost4/",
        sourceFingerprint: "fingerprint-1",
        sourceHandle: "qa_venue",
        sourceIdentity: "source-identity-1",
        sourceOccurrenceKey: expectedOccurrence.key,
        updatedAt: 99,
      },
    ],
    instagramSourceOccurrenceReceipts: [
      {
        _id: "receipt_1",
        deferredChildCount: 0,
        deferredChildKeys: [],
        expectedKeys: [expectedOccurrence.key],
        expectedOccurrences: [expectedOccurrence],
        satisfiedKeys: [expectedOccurrence.key],
        satisfiedOccurrences: [
          { eventId: "event_source_1", key: expectedOccurrence.key },
        ],
        sourceFingerprint: "fingerprint-1",
        sourceIdentity: "source-identity-1",
      },
    ],
    scrapedPosts: [
      {
        _id: "source_document_1",
        handle: "qa_venue",
        imageUrls: [],
        instagramPostUrl: "https://www.instagram.com/reel/CanonicalPost4/",
        postId: "CanonicalPost4",
        processingStatus: "completed",
        sourceRevision: 3,
        analysisRevision: 3,
        analysisResultJson: JSON.stringify({ is_event: true }),
        username: "qa_venue",
      },
    ],
  });
  await assertAdditiveIdempotentMigration({
    assertApplied() {
      const link = state.tables.instagramEventSources.get("source_link_1");
      assert.equal(
        link.canonicalSourceUrl,
        "https://www.instagram.com/p/CanonicalPost4/",
      );
      assert.ok(link.sourceOccurrenceId);
      assert.equal(
        link.updatedAt,
        99,
        "Additive provenance backfill must preserve link version.",
      );
      const occurrence = state.tables.sourceOccurrences.get(
        link.sourceOccurrenceId,
      );
      assert.equal(occurrence.canonicalEventId, "event_source_1");
      assert.equal(occurrence.sourceRevision, 3);
      assert.equal(occurrence.state, "satisfied");
    },
    expectedUpdates: 1,
    label: "source occurrences",
    mutation: backfillSourceOccurrencesBatch,
    state,
  });
  const migratedOccurrence = [...state.tables.sourceOccurrences.values()][0];
  state.tables.sourceOccurrences.set("source_occurrence_duplicate", {
    ...structuredClone(migratedOccurrence),
    _id: "source_occurrence_duplicate",
  });
  const duplicateVerification = await backfillSourceOccurrencesBatch._handler(
    { db: state.db },
    { cursor: null, dryRun: true, limit: 25 },
  );
  assert.equal(duplicateVerification.updatedCount, 0);
  assert.equal(
    duplicateVerification.mismatchCount,
    1,
    "Duplicate first-class source identities must be reported as a row mismatch, not abort the migration batch.",
  );
}

{
  const state = makeDb({
    scrapedPosts: [
      {
        _id: "cursor_post_1",
        handle: "qa",
        imageUrls: [],
        instagramPostUrl: "https://instagram.com/p/CursorOne/",
        postId: "CursorOne",
        username: "qa",
      },
      {
        _id: "cursor_post_2",
        handle: "qa",
        imageUrls: [],
        instagramPostUrl: "https://instagram.com/p/CursorTwo/",
        postId: "CursorTwo",
        username: "qa",
      },
    ],
  });
  const first = await backfillSourceDocumentCanonicalUrlsBatch._handler(
    { db: state.db },
    { cursor: null, dryRun: false, limit: 1 },
  );
  assert.equal(first.isDone, false);
  await assert.rejects(
    backfillSourceDocumentCanonicalUrlsBatch._handler(
      { db: state.db },
      { cursor: "9", dryRun: false, limit: 1 },
    ),
    /cursor does not match/i,
    "Apply retries must continue from the exact committed cursor.",
  );
  const second = await backfillSourceDocumentCanonicalUrlsBatch._handler(
    { db: state.db },
    { cursor: first.continueCursor, dryRun: false, limit: 1 },
  );
  assert.equal(second.isDone, true);
  const completedState = [
    ...state.tables.eventDomainMigrationState.values(),
  ][0];
  assert.equal(completedState.scannedCount, 2);
  assert.ok(completedState.completedAt);
  await assert.rejects(
    backfillSourceDocumentCanonicalUrlsBatch._handler(
      { db: state.db },
      { cursor: null, dryRun: false, limit: 2 },
    ),
    /already finished/i,
  );
  await backfillSourceDocumentCanonicalUrlsBatch._handler(
    { db: state.db },
    { cursor: null, dryRun: false, limit: 2, restart: true },
  );
  const restartedState = [
    ...state.tables.eventDomainMigrationState.values(),
  ][0];
  assert.equal(restartedState.attempt, 2);
  assert.equal(restartedState.mismatchCount, 0);
  assert.equal(restartedState.scannedCount, 2);
}

{
  const state = makeDb({
    scrapedPosts: [
      {
        _id: "repairable_post",
        handle: "qa",
        imageUrls: [],
        instagramPostUrl: "not-an-instagram-url",
        postId: "Repairable",
        username: "qa",
      },
    ],
  });
  await backfillSourceDocumentCanonicalUrlsBatch._handler(
    { db: state.db },
    { cursor: null, dryRun: false, limit: 1 },
  );
  let progress = [...state.tables.eventDomainMigrationState.values()][0];
  assert.equal(progress.isDone, true);
  assert.equal(progress.completedAt, undefined);
  assert.equal(progress.mismatchCount, 1);
  state.tables.scrapedPosts.get("repairable_post").instagramPostUrl =
    "https://instagram.com/reel/Repairable/";
  await backfillSourceDocumentCanonicalUrlsBatch._handler(
    { db: state.db },
    { cursor: null, dryRun: false, limit: 1, restart: true },
  );
  progress = [...state.tables.eventDomainMigrationState.values()][0];
  assert.equal(progress.attempt, 2);
  assert.equal(progress.mismatchCount, 0);
  assert.ok(
    progress.completedAt,
    "A clean restarted verification run must unlock readiness.",
  );
}

{
  const expected = {
    artists: ["Topology Artist"],
    date: "2026-09-20",
    key: "topology-key",
    time: "21:00",
    title: "Topology Event",
    venue: "Topology Venue",
  };
  const state = makeDb({
    events: [
      {
        _id: "topology-event",
        ...expected,
        eventType: "concert",
        sourceOccurrenceKey: expected.key,
        status: "approved",
      },
    ],
    instagramEventSources: [
      {
        _id: "topology-link",
        eventId: "topology-event",
        sourceFingerprint: "topology-fingerprint",
        sourceIdentity: "topology-source",
        sourceOccurrenceId: "topology-occurrence",
        sourceOccurrenceKey: expected.key,
      },
    ],
    instagramSourceOccurrenceReceipts: [
      {
        _id: "topology-receipt",
        deferredChildCount: 0,
        deferredChildKeys: [],
        expectedKeys: [expected.key],
        expectedOccurrences: [expected],
        satisfiedKeys: [expected.key],
        satisfiedOccurrences: [
          { eventId: "topology-event", key: expected.key },
        ],
        sourceFingerprint: "topology-fingerprint",
        sourceIdentity: "topology-source",
      },
    ],
    sourceOccurrences: [
      {
        _id: "topology-occurrence",
        canonicalEventId: "topology-event",
        sourceFingerprint: "topology-fingerprint",
        sourceIdentity: "topology-source",
        sourceOccurrenceKey: expected.key,
        state: "satisfied",
      },
    ],
  });
  const dryRun = await auditSourceOccurrenceReceiptTopologyBatch._handler(
    { db: state.db },
    { cursor: null, dryRun: true, limit: 25 },
  );
  assert.equal(dryRun.mismatchCount, 0);
  assert.equal(dryRun.unchangedCount, 1);
  assert.equal(state.tables.eventDomainMigrationState.size, 0);

  await auditSourceOccurrenceReceiptTopologyBatch._handler(
    { db: state.db },
    { cursor: null, dryRun: false, limit: 25 },
  );
  const progress = [...state.tables.eventDomainMigrationState.values()][0];
  assert.equal(
    isCompleteReceiptTopologyCoverage(progress, topologyEpochSnapshot(state)),
    true,
  );
  await markSourceOccurrenceTopologyMutation(
    { db: state.db },
    { verified: true },
  );
  assert.equal(
    isCompleteReceiptTopologyCoverage(progress, topologyEpochSnapshot(state)),
    true,
    "A locally proven topology mutation must carry the verified invariant forward.",
  );
}

{
  const expected = {
    artists: ["Receipt-only Artist"],
    date: "2026-09-21",
    key: "receipt-only-key",
    time: "22:00",
    title: "Receipt-only Event",
    venue: "Receipt-only Venue",
  };
  const state = makeDb({
    events: [
      {
        _id: "receipt-only-event",
        ...expected,
        eventType: "concert",
        sourceOccurrenceKey: expected.key,
        status: "approved",
      },
    ],
    instagramSourceOccurrenceReceipts: [
      {
        _id: "receipt-only-receipt",
        deferredChildCount: 0,
        deferredChildKeys: [],
        expectedKeys: [expected.key],
        expectedOccurrences: [expected],
        satisfiedKeys: [expected.key],
        satisfiedOccurrences: [
          { eventId: "receipt-only-event", key: expected.key },
        ],
        sourceFingerprint: "receipt-only-fingerprint",
        sourceIdentity: "receipt-only-source",
      },
    ],
  });
  const result = await auditSourceOccurrenceReceiptTopologyBatch._handler(
    { db: state.db },
    { cursor: null, dryRun: false, limit: 25 },
  );
  assert.equal(result.mismatchCount, 1);
  const progress = [...state.tables.eventDomainMigrationState.values()][0];
  assert.equal(progress.completedAt, undefined);
  assert.equal(
    isCompleteReceiptTopologyCoverage(progress, topologyEpochSnapshot(state)),
    false,
  );
  assert.equal(state.tables.events.has("receipt-only-event"), true);
  assert.equal(state.tables.instagramSourceOccurrenceReceipts.size, 1);
}

{
  const receipts = Array.from({ length: 5 }, (_, index) => ({
    _id: `bounded-audit-receipt-${index}`,
    deferredChildCount: 0,
    deferredChildKeys: [],
    expectedKeys: [],
    expectedOccurrences: [],
    satisfiedKeys: [],
    satisfiedOccurrences: [],
    sourceFingerprint: `bounded-audit-fingerprint-${index}`,
    sourceIdentity: `bounded-audit-source-${index}`,
  }));
  const state = makeDb({ instagramSourceOccurrenceReceipts: receipts });
  const first = await auditSourceOccurrenceReceiptTopologyBatch._handler(
    { db: state.db },
    { cursor: null, dryRun: false, limit: 50 },
  );
  assert.equal(
    first.scannedCount,
    4,
    "Receipt audits must retain their dedicated read cap.",
  );
  assert.equal(first.isDone, false);
  const second = await auditSourceOccurrenceReceiptTopologyBatch._handler(
    { db: state.db },
    { cursor: first.continueCursor, dryRun: false, limit: 50 },
  );
  assert.equal(second.scannedCount, 1);
  assert.equal(second.isDone, true);
  const progress = [...state.tables.eventDomainMigrationState.values()][0];
  assert.equal(progress.scannedCount, 5);
  assert.equal(
    isCompleteReceiptTopologyCoverage(progress, topologyEpochSnapshot(state)),
    true,
  );
}

{
  const receipts = Array.from({ length: 5 }, (_, index) => ({
    _id: `epoch-fenced-audit-receipt-${index}`,
    deferredChildCount: 0,
    deferredChildKeys: [],
    expectedKeys: [],
    expectedOccurrences: [],
    satisfiedKeys: [],
    satisfiedOccurrences: [],
    sourceFingerprint: `epoch-fenced-audit-fingerprint-${index}`,
    sourceIdentity: `epoch-fenced-audit-source-${index}`,
  }));
  const state = makeDb({ instagramSourceOccurrenceReceipts: receipts });
  const first = await auditSourceOccurrenceReceiptTopologyBatch._handler(
    { db: state.db },
    { cursor: null, dryRun: false, limit: 4 },
  );
  assert.equal(first.isDone, false);
  const progressBefore = structuredClone(
    [...state.tables.eventDomainMigrationState.values()][0],
  );
  await markSourceOccurrenceTopologyMutation(
    { db: state.db },
    { verified: false },
  );
  await assert.rejects(
    auditSourceOccurrenceReceiptTopologyBatch._handler(
      { db: state.db },
      { cursor: first.continueCursor, dryRun: false, limit: 4 },
    ),
    /changed without verification.*restart/i,
  );
  assert.deepEqual(
    [...state.tables.eventDomainMigrationState.values()][0],
    progressBefore,
    "A dirty epoch must reject resume before audit progress changes.",
  );
}

console.log(
  "Event-domain migration QA passed (dry-run, fenced resume/restart, apply, progress, and idempotency).",
);
