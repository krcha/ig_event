import assert from "node:assert/strict";

import {
  buildEventOccurrenceIndexPatch,
  syncSourceOccurrencePlan as rawSyncSourceOccurrencePlan,
} from "../convex/sourceOccurrences.ts";
import { serializeStructuredFacts } from "../lib/domain/occurrences/facts.ts";
import {
  assertExistingSourceOccurrenceReceiptWithinBounds,
  assertSourceOccurrencePlanMatchesSourceDocument,
  MAX_SOURCE_OCCURRENCE_ARTISTS,
  MAX_SOURCE_OCCURRENCE_KEYS_PER_SOURCE,
  MAX_SOURCE_OCCURRENCE_STRING_LENGTH,
  MAX_STRUCTURED_FACTS_JSON_LENGTH,
  recordSourceOccurrenceSatisfaction,
  reconcileExistingSourceOccurrenceReceipt,
} from "../convex/internal/sourceOccurrenceReceipts.ts";
import { buildInstagramSourceOccurrenceFingerprint } from "../lib/domain/occurrences/source-fingerprint.ts";
import { receiptExpectedMatchesOccurrenceFacts } from "../convex/internal/reconciliationReceiptFacts.ts";

const syncSourceOccurrencePlan = (options) =>
  rawSyncSourceOccurrencePlan({
    ...options,
    topologyEpochVerified: true,
  });

{
  const sourceDocument = {
    _creationTime: 1,
    _id: "source_plan_binding_1",
    altText: "  Poster evidence  ",
    caption: "  Caption evidence  ",
    createdAt: 1,
    handle: "venue_account",
    imageUrls: [],
    instagramPostUrl: "https://www.instagram.com/p/PLANBINDING1/?utm_source=qa",
    locationName: "  Venue location  ",
    postId: "PLANBINDING1",
    processingAttempts: 1,
    processingStatus: "processing",
    sourceRevision: 1,
    updatedAt: 1,
    username: "venue_account",
  };
  const plan = {
    deferredChildCount: 0,
    deferredChildKeys: [],
    expectedKeys: [],
    expectedOccurrences: [],
    observedChildKeys: [],
    sourceFingerprint: buildInstagramSourceOccurrenceFingerprint(sourceDocument),
    sourceIdentity: "instagram-source-identity-v1:PLANBINDING1",
  };
  assert.doesNotThrow(() =>
    assertSourceOccurrencePlanMatchesSourceDocument(plan, sourceDocument),
  );
  assert.throws(
    () =>
      assertSourceOccurrencePlanMatchesSourceDocument(
        { ...plan, sourceIdentity: "instagram-source-identity-v1:OTHER" },
        sourceDocument,
      ),
    /does not match the fenced source document/i,
    "A valid lease must not authorize a plan for another source identity.",
  );
  assert.throws(
    () =>
      assertSourceOccurrencePlanMatchesSourceDocument(
        { ...plan, sourceFingerprint: "instagram-source-v2:stale" },
        sourceDocument,
      ),
    /does not match the fenced source document/i,
    "A valid lease must not authorize stale source evidence.",
  );
}

function makeDb({ identities, venues } = {}) {
  const sourceOccurrences = new Map();
  const topologyEpochs = new Map();
  const venueRows = new Map(
    (venues ?? [{
      _id: "venue_1",
      aliases: [],
      category: "club",
      instagramHandle: "venue_account",
      name: "Venue Account",
      publicStatus: "published",
      scrapeActive: true,
    }]).map((row) => [row._id, structuredClone(row)]),
  );
  const identityRows = identities ?? [{
    _id: "identity_1",
    active: true,
    kind: "canonical_name",
    normalizedValue: "venue account",
    rawValue: "Venue Account",
    venueId: "venue_1",
  }];
  let nextId = 1;

  return {
    sourceOccurrences,
    db: {
      query(table) {
        const filters = {};
        const chain = {
          withIndex(index, apply) {
            const builder = {
              eq(field, value) {
                filters[field] = value;
                return builder;
              },
            };
            apply(builder);
            return chain;
          },
          async take(limit) {
            const rows = table === "venueIdentities"
              ? identityRows
              : table === "venues"
                ? [...venueRows.values()]
                : table === "sourceOccurrenceTopologyEpoch"
                  ? [...topologyEpochs.values()]
                  : [...sourceOccurrences.values()];
            return rows
              .filter((row) =>
                Object.entries(filters).every(([field, value]) => row[field] === value),
              )
              .slice(0, limit);
          },
          async unique() {
            assert.ok(
              table === "sourceOccurrences" ||
                table === "sourceOccurrenceTopologyEpoch",
            );
            const sourceRows = table === "sourceOccurrences"
              ? sourceOccurrences
              : topologyEpochs;
            const matches = [...sourceRows.values()].filter((row) =>
              Object.entries(filters).every(([field, value]) => row[field] === value),
            );
            assert.ok(matches.length <= 1, "Occurrence identity must remain unique.");
            return matches[0] ?? null;
          },
        };
        return chain;
      },
      async get(id) {
        return venueRows.get(id) ?? sourceOccurrences.get(id) ?? null;
      },
      async insert(table, value) {
        assert.ok(
          table === "sourceOccurrences" ||
            table === "sourceOccurrenceTopologyEpoch",
        );
        const id = `${table}_${nextId++}`;
        const target = table === "sourceOccurrences"
          ? sourceOccurrences
          : topologyEpochs;
        target.set(id, { _id: id, ...structuredClone(value) });
        return id;
      },
      async patch(id, patch) {
        const target = sourceOccurrences.has(id) ? sourceOccurrences : topologyEpochs;
        const existing = target.get(id);
        assert.ok(existing, `Missing occurrence ${id}.`);
        target.set(id, { ...existing, ...structuredClone(patch) });
      },
    },
  };
}

function makeReceiptDb({ event, link, receipt }) {
  const tables = {
    events: new Map([[event._id, structuredClone(event)]]),
    instagramEventSources: new Map([[link._id, structuredClone(link)]]),
    instagramSourceOccurrenceReceipts: new Map([
      [receipt._id, structuredClone(receipt)],
    ]),
    sourceOccurrenceTopologyEpoch: new Map(),
  };
  let nextId = 1;
  const rows = (table, filters) =>
    [...tables[table].values()].filter((row) =>
      Object.entries(filters).every(([field, value]) => row[field] === value),
    );
  return {
    tables,
    db: {
      async delete(id) {
        for (const table of Object.values(tables)) table.delete(id);
      },
      async get(id) {
        for (const table of Object.values(tables)) {
          if (table.has(id)) return table.get(id);
        }
        return null;
      },
      async insert(table, value) {
        const id = `${table}_${nextId++}`;
        tables[table].set(id, { _id: id, ...structuredClone(value) });
        return id;
      },
      async patch(id, patch) {
        for (const table of Object.values(tables)) {
          if (!table.has(id)) continue;
          Object.assign(table.get(id), structuredClone(patch));
          return;
        }
        throw new Error(`Missing receipt QA row ${id}.`);
      },
      query(table) {
        const filters = {};
        const chain = {
          withIndex(_index, configure) {
            const builder = {
              eq(field, value) {
                filters[field] = value;
                return builder;
              },
            };
            configure(builder);
            return chain;
          },
          async take(limit) {
            return rows(table, filters).slice(0, limit);
          },
          async unique() {
            const matches = rows(table, filters);
            assert.ok(matches.length <= 1);
            return matches[0] ?? null;
          },
        };
        return chain;
      },
    },
  };
}

const sourceDocument = {
  _id: "source_document_1",
  handle: "venue_account",
  instagramPostUrl: "https://www.instagram.com/reel/source-model-1/?utm_source=qa",
  postId: "source-model-1",
  sourceRevision: 4,
};
const makeStructuredFacts = ({ artists, date, time, title, venue }) => ({
  artistClaims: artists,
  evidence: [
    { exactText: date, field: "date", source: "poster" },
    { exactText: time, field: "start_time", source: "poster" },
    { exactText: venue, field: "venue", source: "source_account" },
  ],
  eventTypeClaim: "nightlife",
  localDate: date,
  startTime: time,
  timeRelation: "exact",
  titleClaim: title,
  venueClaim: venue,
  venueHandleClaim: "venue_account",
  policy: {
    approvalDisposition: "approved",
    autoApproveRule: "qa_fact_native",
    pendingReasons: [],
    signals: ["qa_fact_native"],
    structuredEvidenceVerified: true,
  },
});
const structuredFactsA = makeStructuredFacts({
  artists: ["Artist A"],
  date: "2026-09-04",
  time: "20:00",
  title: "Friday Programme",
  venue: "Venue Account",
});
const structuredFactsB = makeStructuredFacts({
  artists: ["Artist B"],
  date: "2026-09-05",
  time: "22:00",
  title: "Saturday Programme",
  venue: "Venue Account",
});
const plan = {
  deferredChildKeys: [],
  expectedKeys: ["occurrence:a", "occurrence:b"],
  expectedOccurrences: [
    {
      artists: ["Artist A"],
      date: "2026-09-04",
      key: "occurrence:a",
      time: "20:00",
      title: "Friday Programme",
      venue: "Venue Account",
      factsJson: serializeStructuredFacts(structuredFactsA),
    },
    {
      artists: ["Artist B"],
      date: "2026-09-05",
      key: "occurrence:b",
      time: "22:00",
      title: "Saturday Programme",
      venue: "Venue Account",
      factsJson: serializeStructuredFacts(structuredFactsB),
    },
  ],
  sourceFingerprint: "source-fingerprint-v4",
  sourceIdentity: "instagram:venue_account:source-model-1",
};
const representativeA = {
  _id: "event_a",
  artists: ["Artist A"],
  date: "2026-09-04",
  eventType: "nightlife",
  normalizedVenueIdentity: "venue account",
  normalizedVenueInstagramHandle: "venue_account",
  time: "20:00",
  title: "Friday Programme",
  venue: "Venue Account",
  venueId: "venue_1",
};
const representativeB = {
  ...representativeA,
  _id: "event_b",
  artists: ["Artist B"],
  date: "2026-09-05",
  time: "22:00",
  title: "Saturday Programme",
};
const canonicalRepresentativeA = {
  ...representativeA,
  artists: ["Canonical Artist Alias"],
  time: "20:15",
  title: "Canonical Display Alias",
};

{
  const correctedExpected = {
    ...plan.expectedOccurrences[0],
    title: "Reviewed Corrected Title",
  };
  const immutableFactsJson = plan.expectedOccurrences[0].factsJson;
  const correctedOccurrence = {
    factsJson: immutableFactsJson,
    normalizedOccurrenceJson: JSON.stringify({
      artists: correctedExpected.artists,
      date: correctedExpected.date,
      eventType: "nightlife",
      time: correctedExpected.time,
      title: correctedExpected.title,
      venue: correctedExpected.venue,
      venueId: "venue_1",
    }),
    sourceOccurrenceKey: correctedExpected.key,
  };
  assert.equal(
    receiptExpectedMatchesOccurrenceFacts(
      correctedExpected,
      correctedOccurrence,
    ),
    true,
    "Reviewed normalized corrections must not rewrite immutable source facts to remain valid.",
  );
  assert.equal(
    correctedOccurrence.factsJson,
    immutableFactsJson,
    "The correction compatibility path must preserve typed source facts byte-for-byte.",
  );
}

{
  const { db, sourceOccurrences } = makeDb();
  await syncSourceOccurrencePlan({
    ctx: { db },
    plan,
    representativeEvent: canonicalRepresentativeA,
    satisfiedKey: "occurrence:a",
    sourceDocument,
  });

  const afterPartial = [...sourceOccurrences.values()];
  assert.equal(afterPartial.length, 2, "One source document must materialize every expected child.");
  assert.equal(
    afterPartial.find((row) => row.sourceOccurrenceKey === "occurrence:a")?.state,
    "satisfied",
  );
  assert.equal(
    afterPartial.find((row) => row.sourceOccurrenceKey === "occurrence:b")?.state,
    "expected",
    "A partial write must leave the missing child explicitly incomplete.",
  );
  const expectedB = afterPartial.find(
    (row) => row.sourceOccurrenceKey === "occurrence:b",
  );
  assert.equal(expectedB?.venueResolutionStatus, "resolved");
  assert.equal(expectedB?.venueId, "venue_1");
  assert.deepEqual(
    JSON.parse(expectedB.factsJson),
    structuredFactsB,
    "First-class source occurrences must persist typed StructuredFacts exactly.",
  );
  assert.equal(
    Object.hasOwn(JSON.parse(expectedB.factsJson), "key"),
    false,
    "factsJson must not be the legacy expected-occurrence tuple projection.",
  );
  const satisfiedA = afterPartial.find(
    (row) => row.sourceOccurrenceKey === "occurrence:a",
  );
  const factSignatureA = buildEventOccurrenceIndexPatch({
    artists: structuredFactsA.artistClaims,
    date: structuredFactsA.localDate,
    eventType: structuredFactsA.eventTypeClaim,
    normalizedVenueIdentity: structuredFactsA.venueClaim,
    normalizedVenueInstagramHandle: "venue_account",
    time: structuredFactsA.startTime,
    title: structuredFactsA.titleClaim,
    venue: structuredFactsA.venueClaim,
    venueId: "venue_1",
  });
  assert.equal(
    satisfiedA.occurrenceSignatureHash,
    factSignatureA.occurrenceSignatureHash,
    "A satisfied SourceOccurrence signature must come from source facts, not a canonical display projection.",
  );
  assert.equal(
    JSON.parse(satisfiedA.normalizedOccurrenceJson).title,
    structuredFactsA.titleClaim,
  );
  const satisfiedABeforeSiblingWrite = structuredClone(
    afterPartial.find((row) => row.sourceOccurrenceKey === "occurrence:a"),
  );

  await syncSourceOccurrencePlan({
    ctx: { db },
    plan: {
      ...plan,
      expectedOccurrences: [
        {
          ...plan.expectedOccurrences[0],
          venue: "Resolver Ownership Changed",
          factsJson: serializeStructuredFacts({
            ...structuredFactsA,
            venueClaim: "Resolver Ownership Changed",
          }),
        },
        plan.expectedOccurrences[1],
      ],
    },
    representativeEvent: representativeB,
    satisfiedKey: "occurrence:b",
    sourceDocument,
  });
  const complete = [...sourceOccurrences.values()];
  assert.equal(complete.length, 2);
  assert.deepEqual(
    complete
      .map((row) => [row.sourceOccurrenceKey, row.state, row.canonicalEventId])
      .sort(),
    [
      ["occurrence:a", "satisfied", "event_a"],
      ["occurrence:b", "satisfied", "event_b"],
    ],
    "Persisting a later child must not regress an earlier satisfied child.",
  );
  const satisfiedAAfterSiblingWrite = complete.find(
    (row) => row.sourceOccurrenceKey === "occurrence:a",
  );
  for (const field of [
    "canonicalEventId",
    "factsJson",
    "normalizedOccurrenceJson",
    "occurrenceSignatureHash",
    "occurrenceVenueIdentity",
    "venueId",
    "venueResolutionStatus",
  ]) {
    assert.deepEqual(
      satisfiedAAfterSiblingWrite[field],
      satisfiedABeforeSiblingWrite[field],
      `A sibling write must preserve satisfied occurrence field ${field}.`,
    );
  }

  await syncSourceOccurrencePlan({
    ctx: { db },
    plan,
    representativeEvent: representativeB,
    satisfiedKey: "occurrence:b",
    sourceDocument,
  });
  assert.equal(sourceOccurrences.size, 2, "A retry must remain idempotent.");

  await assert.rejects(
    () =>
      syncSourceOccurrencePlan({
        ctx: { db },
        plan: { ...plan, sourceFingerprint: "stale-generation" },
        representativeEvent: representativeB,
        satisfiedKey: "occurrence:b",
        sourceDocument: { ...sourceDocument, sourceRevision: 3 },
      }),
    /source occurrence identity is bound to incompatible current state/i,
    "A stale source revision must not rewrite a newer occurrence.",
  );
}

{
  const ambiguousVenues = [
    {
      _id: "venue_left",
      aliases: ["Shared Alias"],
      category: "club",
      instagramHandle: "left",
      name: "Left Venue",
      publicStatus: "published",
      scrapeActive: true,
    },
    {
      _id: "venue_right",
      aliases: ["Shared Alias"],
      category: "club",
      instagramHandle: "right",
      name: "Right Venue",
      publicStatus: "published",
      scrapeActive: true,
    },
  ];
  const { db, sourceOccurrences } = makeDb({
    venues: ambiguousVenues,
    identities: ambiguousVenues.map((venue, index) => ({
      _id: `identity_ambiguous_${index}`,
      active: true,
      kind: "alias",
      normalizedValue: "shared alias",
      rawValue: "Shared Alias",
      venueId: venue._id,
    })),
  });
  await syncSourceOccurrencePlan({
    ctx: { db },
    plan: {
      deferredChildKeys: [],
      expectedKeys: ["occurrence:ambiguous"],
      expectedOccurrences: [{
        artists: [],
        date: "2026-09-06",
        key: "occurrence:ambiguous",
        title: "Ambiguous Venue Event",
        venue: "Shared Alias",
      }],
      sourceFingerprint: "ambiguous-fingerprint",
      sourceIdentity: "ambiguous-source",
    },
    sourceDocument,
  });
  const occurrence = [...sourceOccurrences.values()][0];
  assert.equal(occurrence.venueResolutionStatus, "ambiguous");
  assert.equal(occurrence.venueId, undefined);
}

{
  const { db, sourceOccurrences } = makeDb({ identities: [], venues: [] });
  await syncSourceOccurrencePlan({
    ctx: { db },
    plan: {
      deferredChildKeys: [],
      expectedKeys: ["occurrence:unknown"],
      expectedOccurrences: [{
        artists: [],
        date: "2026-09-07",
        key: "occurrence:unknown",
        title: "Unknown Venue Event",
        venue: "Never Seen Venue",
      }],
      sourceFingerprint: "unknown-fingerprint",
      sourceIdentity: "unknown-source",
    },
    sourceDocument,
  });
  const occurrence = [...sourceOccurrences.values()][0];
  assert.equal(occurrence.venueResolutionStatus, "unresolved");
  assert.equal(occurrence.venueId, undefined);
}

{
  const { db, sourceOccurrences } = makeDb();
  await syncSourceOccurrencePlan({
    ctx: { db },
    plan: {
      ...plan,
      deferredChildKeys: ["occurrence:deferred"],
      expectedKeys: ["occurrence:a"],
      expectedOccurrences: [plan.expectedOccurrences[0]],
    },
    representativeEvent: representativeA,
    satisfiedKey: "occurrence:a",
    sourceDocument,
  });
  assert.equal(
    [...sourceOccurrences.values()].find(
      (row) => row.sourceOccurrenceKey === "occurrence:deferred",
    )?.state,
    "deferred",
  );
}

{
  const oversizedKeys = Array.from(
    { length: MAX_SOURCE_OCCURRENCE_KEYS_PER_SOURCE + 1 },
    (_, index) => `occurrence:${index}`,
  );
  const individuallyBoundedLargeFactsJson = serializeStructuredFacts({
    ...structuredFactsA,
    policy: {
      ...structuredFactsA.policy,
      signals: Array.from(
        { length: 12 },
        (_, index) => `${index}:${"x".repeat(3_900)}`,
      ),
    },
  });
  assert.ok(
    individuallyBoundedLargeFactsJson.length < MAX_STRUCTURED_FACTS_JSON_LENGTH,
  );
  const aggregatePayloadKeys = Array.from(
    { length: 12 },
    (_, index) => `occurrence:aggregate:${index}`,
  );
  await assert.rejects(
    () =>
      syncSourceOccurrencePlan({
        ctx: { db: makeDb().db },
        plan: {
          ...plan,
          expectedKeys: aggregatePayloadKeys,
          expectedOccurrences: aggregatePayloadKeys.map((key) => ({
            ...plan.expectedOccurrences[0],
            factsJson: individuallyBoundedLargeFactsJson,
            key,
          })),
        },
        sourceDocument,
      }),
    /hard bounds/i,
    "Individually valid fact payloads must still fit one bounded receipt plan.",
  );
  await assert.rejects(
    () =>
      syncSourceOccurrencePlan({
        ctx: { db: makeDb().db },
        plan: {
          ...plan,
          expectedKeys: oversizedKeys,
          expectedOccurrences: oversizedKeys.map((key) => ({
            artists: [],
            date: "2026-09-04",
            key,
            title: key,
            venue: "Venue Account",
          })),
        },
        sourceDocument,
      }),
    /hard bounds/i,
    "The first-class synchronization boundary must reject oversized occurrence sets.",
  );
  await assert.rejects(
    () =>
      syncSourceOccurrencePlan({
        ctx: { db: makeDb().db },
        plan: {
          ...plan,
          expectedKeys: ["occurrence:artists"],
          expectedOccurrences: [
            {
              ...plan.expectedOccurrences[0],
              artists: Array.from(
                { length: MAX_SOURCE_OCCURRENCE_ARTISTS + 1 },
                (_, index) => `Artist ${index}`,
              ),
              key: "occurrence:artists",
            },
          ],
        },
        sourceDocument,
      }),
    /hard bounds/i,
    "An occurrence must not carry an unbounded artist array.",
  );
  await assert.rejects(
    () =>
      syncSourceOccurrencePlan({
        ctx: { db: makeDb().db },
        plan: {
          ...plan,
          expectedKeys: ["occurrence:string"],
          expectedOccurrences: [
            {
              ...plan.expectedOccurrences[0],
              key: "occurrence:string",
              title: "x".repeat(MAX_SOURCE_OCCURRENCE_STRING_LENGTH + 1),
            },
          ],
        },
        sourceDocument,
      }),
    /hard bounds/i,
    "Occurrence strings must be hard bounded before persistence.",
  );
  await assert.rejects(
    () =>
      syncSourceOccurrencePlan({
        ctx: { db: makeDb().db },
        plan: {
          ...plan,
          expectedKeys: ["occurrence:facts-oversized"],
          expectedOccurrences: [
            {
              ...plan.expectedOccurrences[0],
              key: "occurrence:facts-oversized",
              factsJson: "x".repeat(MAX_STRUCTURED_FACTS_JSON_LENGTH + 1),
            },
          ],
        },
        sourceDocument,
      }),
    /hard bounds/i,
    "Typed fact payloads must be bounded before persistence.",
  );
  await assert.rejects(
    () =>
      syncSourceOccurrencePlan({
        ctx: { db: makeDb().db },
        plan: {
          ...plan,
          expectedKeys: ["occurrence:facts-mismatch"],
          expectedOccurrences: [
            {
              ...plan.expectedOccurrences[0],
              key: "occurrence:facts-mismatch",
              factsJson: JSON.stringify({
                titleClaim: "Incomplete fact payload",
              }),
            },
          ],
        },
        sourceDocument,
      }),
    /hard bounds/i,
    "factsJson must contain the complete typed StructuredFacts contract.",
  );
  await assert.rejects(
    () =>
      reconcileExistingSourceOccurrenceReceipt(
        { db: { query: () => { throw new Error("database must not be read"); } } },
        {
          confirmedPastKeys: [],
          deferredChildCount: 0,
          deferredChildKeys: [],
          expectedKeys: [],
          expectedOccurrences: [plan.expectedOccurrences[0]],
          observedChildKeys: [],
          sourceFingerprint: plan.sourceFingerprint,
          sourceIdentity: plan.sourceIdentity,
        },
        true,
      ),
    /internally inconsistent/i,
    "A zero-key reconciliation cannot smuggle nonempty occurrence rows into sync.",
  );
  assert.throws(
    () =>
      assertExistingSourceOccurrenceReceiptWithinBounds({
        _id: "oversized-receipt",
        deferredChildCount: 0,
        deferredChildKeys: [],
        expectedKeys: oversizedKeys,
        expectedOccurrences: oversizedKeys.map((key) => ({
          artists: [],
          date: "2026-09-04",
          key,
          title: key,
          venue: "Venue Account",
        })),
        satisfiedKeys: [],
        satisfiedOccurrences: [],
        sourceFingerprint: plan.sourceFingerprint,
        sourceIdentity: plan.sourceIdentity,
      }),
    /hard bounds/i,
    "Oversized persisted receipts must fail before their arrays are traversed by callers.",
  );
}

{
  for (const receiptMode of ["fresh", "empty"]) {
    let receiptReads = 0;
    let writes = 0;
    const emptyReceipt = {
      _id: "campaign-empty-receipt",
      deferredChildCount: 0,
      deferredChildKeys: [],
      expectedKeys: ["occurrence:campaign"],
      expectedOccurrences: [{
        artists: ["Campaign Artist"],
        date: "2026-09-08",
        key: "occurrence:campaign",
        title: "Campaign Event",
        venue: "Venue Account",
      }],
      satisfiedKeys: [],
      satisfiedOccurrences: [],
      sourceFingerprint: "campaign-fingerprint",
      sourceIdentity: "instagram:campaign",
    };
    const db = {
      async get(id) {
        assert.equal(id, "campaign-event");
        return {
          _id: id,
          artists: ["Campaign Artist"],
          date: "2026-09-08",
          eventType: "music",
          moderationNote: "[cross_post_campaign_primary:v1] reviewed",
          status: "approved",
          title: "Campaign Event",
          venue: "Venue Account",
        };
      },
      async insert() {
        writes += 1;
        throw new Error("Campaign guard must run before inserts.");
      },
      async patch() {
        writes += 1;
        throw new Error("Campaign guard must run before patches.");
      },
      query(table) {
        receiptReads += 1;
        assert.equal(table, "instagramSourceOccurrenceReceipts");
        return {
          withIndex() {
            return {
              async unique() {
                return receiptMode === "empty" ? emptyReceipt : null;
              },
            };
          },
        };
      },
    };
    await assert.rejects(
      () =>
        recordSourceOccurrenceSatisfaction(
          { db },
          {
            confirmedPastKeys: [],
            deferredChildCount: 0,
            deferredChildKeys: [],
            expectedKeys: ["occurrence:campaign"],
            expectedOccurrences: emptyReceipt.expectedOccurrences,
            observedChildKeys: ["occurrence:campaign"],
            sourceFingerprint: "campaign-fingerprint",
            sourceIdentity: "instagram:campaign",
          },
          "occurrence:campaign",
          "campaign-event",
          sourceDocument,
        ),
      /campaign lineage.*dedicated re-attestation/i,
      `${receiptMode} receipts must not attach directly to an audited campaign representative.`,
    );
    assert.equal(receiptReads, 0, "Campaign rejection must precede receipt reads.");
    assert.equal(writes, 0, "Campaign rejection must precede all writes.");
  }
}

{
  const retiredKey = "occurrence:retired";
  const receiptState = makeReceiptDb({
    event: {
      _id: "event-retired",
      artists: ["Retired Artist"],
      date: "2026-09-01",
      status: "approved",
      title: "Retired Event",
      venue: "Venue Account",
    },
    link: {
      _id: "link-retired",
      eventId: "event-retired",
      sourceFingerprint: "fingerprint-old",
      sourceIdentity: "instagram:retirement",
      sourceOccurrenceKey: retiredKey,
    },
    receipt: {
      _id: "receipt-retired",
      deferredChildCount: 0,
      deferredChildKeys: [],
      expectedKeys: [retiredKey],
      expectedOccurrences: [
        {
          artists: ["Retired Artist"],
          date: "2026-09-01",
          key: retiredKey,
          title: "Retired Event",
          venue: "Venue Account",
        },
      ],
      satisfiedKeys: [retiredKey],
      satisfiedOccurrences: [{ eventId: "event-retired", key: retiredKey }],
      sourceFingerprint: "fingerprint-old",
      sourceIdentity: "instagram:retirement",
    },
  });
  const retirementPlan = {
    confirmedPastKeys: [retiredKey],
    deferredChildCount: 0,
    deferredChildKeys: [],
    expectedKeys: [],
    expectedOccurrences: [],
    observedChildKeys: [],
    previousSourceFingerprint: "fingerprint-old",
    sourceFingerprint: "fingerprint-new",
    sourceIdentity: "instagram:retirement",
  };
  const retired = await reconcileExistingSourceOccurrenceReceipt(
    { db: receiptState.db },
    retirementPlan,
    true,
  );
  assert.deepEqual(retired.affectedRepresentativeEventIds, ["event-retired"]);
  assert.equal(receiptState.tables.instagramEventSources.size, 0);
  assert.deepEqual(
    receiptState.tables.instagramSourceOccurrenceReceipts.get("receipt-retired")
      .satisfiedOccurrences,
    [],
  );
  const retried = await reconcileExistingSourceOccurrenceReceipt(
    { db: receiptState.db },
    retirementPlan,
    true,
  );
  assert.deepEqual(
    retried.affectedRepresentativeEventIds,
    [],
    "Retrying a completed zero-occurrence retirement must remain idempotent.",
  );
}

console.log("Source-document/source-occurrence model QA passed.");
