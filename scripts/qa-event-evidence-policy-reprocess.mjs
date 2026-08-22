import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  assertEventEvidencePolicyDateEvidenceTransitionForTesting,
  assertEventEvidencePolicyTitleTransitionForTesting,
  reprocessPendingEventEvidencePolicyBatch,
  rollbackEventEvidencePolicyBatch,
} from "../convex/events.ts";
import { buildUnnamedScheduleFallbackTitle } from "../lib/events/unnamed-schedule-fallback.ts";
import {
  buildForwardPatch,
  rollbackAppliedGroups,
} from "./reprocess-pending-event-evidence-policy.mjs";

const SERVICE_SECRET = "qa-event-evidence-policy-secret";
const ADMIN_SUBJECT = "qa-event-evidence-policy-admin";
const SOURCE_IDENTITY = "instagram-source-identity-v1:qa-relaxed-policy";
const SOURCE_FINGERPRINT = "qa-relaxed-policy-fingerprint";
const SOURCE_HANDLE = "qa_promoter";
const POST_ID = "qa-relaxed-policy";
const POST_URL = `https://www.instagram.com/p/${POST_ID}/`;
const POSTED_AT = "2026-08-21T08:00:00.000Z";
const EVENT_DATE = "2099-09-21";
const EVENT_TIME = "20:00";
const TARGET_ID = "event-target";
const SIBLING_ID = "event-sibling";
const TARGET_KEY = "instagram-occurrence-v2:target";
const SIBLING_KEY = "instagram-occurrence-v2:sibling";
const RECEIPT_ID = "receipt-relaxed-policy";

const benignVenueConflict = {
  field: "venue",
  poster_value: "QA Promoter (canonical hint)",
  caption_value: "QA Physical Hall",
  reason: "Canonical venue hint from the promoter account differs from the caption venue.",
};
const rawExtractionJson = JSON.stringify({
  extraction_contract_version: "event_evidence_v2",
  source_conflicts: [benignVenueConflict],
});

function oldNormalizedFields({
  title,
  venue,
  artists,
  sourceOccurrenceKey,
}) {
  return JSON.stringify({
    extractionContractVersion: "event_evidence_v2",
    sourceGroundingVersion: 5,
    sourceGroundingInstagramHandle: SOURCE_HANDLE,
    sourceAccountRole: "promoter",
    sourceAccountName: "QA Promoter",
    sourceOccurrenceKey,
    sourceOccurrenceSourceFingerprint: SOURCE_FINGERPRINT,
    title,
    normalizedDate: EVENT_DATE,
    time: EVENT_TIME,
    normalizedVenue: venue,
    artists,
    dateEvidenceText: EVENT_DATE,
    dateEvidenceSource: "caption",
    dateEvidenceIsRelative: false,
    dateEvidenceResolvedDate: EVENT_DATE,
    sourceConflictFields: venue === "QA Promoter" ? ["venue"] : [],
    moderationAutoApproved: false,
    moderationPendingReasons: ["source_conflict"],
  });
}

function approvedNormalizedFields({ title, venue, artists, sourceOccurrenceKey }) {
  const sourceCaption =
    "QA Promoter presents Relaxed Approval Event with @qa_artist at QA Physical Hall on 2099-09-21 at 20:00.";
  return JSON.stringify({
    extractionContractVersion: "event_evidence_v2",
    extractionIsEvent: true,
    extractionNonEventReason: "",
    extractionSourceConflicts: [benignVenueConflict],
    extractionSourceConflictCount: 1,
    sourceConflictResolutionVersion: 1,
    materialSourceConflicts: [],
    materialSourceConflictCount: 0,
    benignSourceConflicts: [benignVenueConflict],
    benignSourceConflictCount: 1,
    extractionMode: "caption_only",
    sourceGroundingVersion: 5,
    sourceGroundingEvidence: "persisted_openai_event_evidence_v2",
    sourceGroundingInstagramHandle: SOURCE_HANDLE,
    sourceAccountRole: "promoter",
    sourceAccountName: "QA Promoter",
    sourceGroundingInstagramPostId: POST_ID,
    sourceGroundingInstagramPostUrl: POST_URL,
    sourceGroundingSourceCaption: sourceCaption,
    sourceOccurrenceKey,
    sourceOccurrenceSourceFingerprint: SOURCE_FINGERPRINT,
    dateEvidenceVerified: true,
    timeEvidenceVerified: true,
    identityEvidenceVerified: true,
    venueEvidenceVerified: true,
    structuredEvidenceVerified: true,
    splitEventTotal: 1,
    multiEventSplitDetected: false,
    dateEvidenceText: EVENT_DATE,
    dateEvidenceSource: "caption",
    dateEvidenceIsRelative: false,
    dateEvidenceResolvedDate: EVENT_DATE,
    timeEvidenceKind: "start_time_stated",
    timeSource: "caption",
    timeEvidenceText: EVENT_TIME,
    timeConfidence: 0.99,
    timeStatus: "confirmed",
    title,
    normalizedDate: EVENT_DATE,
    time: EVENT_TIME,
    normalizedVenue: venue,
    artists,
    sourceConflictFields: [],
    approvalTitleSensible: true,
    normalizedIsValid: true,
    titleUsedFallback: false,
    dateSuspiciousYear: false,
    moderationAutoApproved: true,
    moderationAutoApproveRule: "event_evidence_v2",
    moderationPendingReasons: [],
    moderationConfidenceScore: 0.99,
  });
}

function expectedOccurrence(event) {
  return {
    key: event.sourceOccurrenceKey,
    date: event.date,
    time: event.time,
    venue: event.venue,
    title: event.title,
    artists: [...event.artists],
  };
}

function readyFixture() {
  const sourceCaption =
    "QA Promoter presents Relaxed Approval Event with @qa_artist at QA Physical Hall on 2099-09-21 at 20:00.";
  const target = {
    _id: TARGET_ID,
    _creationTime: 1,
    title: "Relaxed Approval Event",
    date: EVENT_DATE,
    time: EVENT_TIME,
    timeSource: "caption",
    timeEvidenceText: EVENT_TIME,
    timeConfidence: 0.99,
    timeStatus: "confirmed",
    timeEvidenceKind: "start_time_stated",
    dateEvidenceText: EVENT_DATE,
    dateEvidenceSource: "caption",
    dateEvidenceIsRelative: false,
    dateEvidenceResolvedDate: EVENT_DATE,
    sourceConflictFields: ["venue"],
    venue: "QA Promoter",
    artists: ["QA Artist"],
    eventType: "music",
    sourceCaption,
    sourcePostedAt: POSTED_AT,
    instagramPostId: POST_ID,
    instagramPostUrl: POST_URL,
    rawExtractionJson,
    sourceOccurrenceKey: TARGET_KEY,
    normalizedFieldsJson: oldNormalizedFields({
      title: "Relaxed Approval Event",
      venue: "QA Promoter",
      artists: ["QA Artist"],
      sourceOccurrenceKey: TARGET_KEY,
    }),
    status: "pending",
    createdAt: 1_000,
    updatedAt: 10_000,
  };
  const sibling = {
    ...target,
    _id: SIBLING_ID,
    title: "Preserved Sibling Event",
    venue: "QA Sibling Hall",
    artists: ["QA Sibling Artist"],
    sourceConflictFields: [],
    sourceOccurrenceKey: SIBLING_KEY,
    normalizedFieldsJson: oldNormalizedFields({
      title: "Preserved Sibling Event",
      venue: "QA Sibling Hall",
      artists: ["QA Sibling Artist"],
      sourceOccurrenceKey: SIBLING_KEY,
    }),
    updatedAt: 10_001,
  };
  const receipt = {
    _id: RECEIPT_ID,
    _creationTime: 1,
    sourceIdentity: SOURCE_IDENTITY,
    sourceFingerprint: SOURCE_FINGERPRINT,
    expectedKeys: [TARGET_KEY, SIBLING_KEY],
    expectedOccurrences: [expectedOccurrence(target), expectedOccurrence(sibling)],
    satisfiedKeys: [TARGET_KEY, SIBLING_KEY],
    satisfiedOccurrences: [
      { key: TARGET_KEY, eventId: TARGET_ID },
      { key: SIBLING_KEY, eventId: SIBLING_ID },
    ],
    deferredChildCount: 0,
    deferredChildKeys: [],
    createdAt: 2_000,
    updatedAt: 20_000,
  };
  return {
    events: [target, sibling],
    instagramSourceOccurrenceReceipts: [receipt],
    instagramEventSources: [
      {
        _id: "link-target",
        eventId: TARGET_ID,
        sourceIdentity: SOURCE_IDENTITY,
        sourceFingerprint: SOURCE_FINGERPRINT,
        sourceOccurrenceKey: TARGET_KEY,
        instagramPostId: POST_ID,
        instagramPostUrl: POST_URL,
        linkedAt: 2_001,
        updatedAt: 2_001,
      },
      {
        _id: "link-sibling",
        eventId: SIBLING_ID,
        sourceIdentity: SOURCE_IDENTITY,
        sourceFingerprint: SOURCE_FINGERPRINT,
        sourceOccurrenceKey: SIBLING_KEY,
        instagramPostId: POST_ID,
        instagramPostUrl: POST_URL,
        linkedAt: 2_002,
        updatedAt: 2_002,
      },
    ],
    scrapedPosts: [
      {
        _id: "scraped-post-relaxed-policy",
        handle: SOURCE_HANDLE,
        username: SOURCE_HANDLE,
        postId: POST_ID,
        caption: sourceCaption,
        instagramPostUrl: POST_URL,
        postedAt: POSTED_AT,
        imageUrls: [],
        sourceRevision: 7,
        analysisRevision: 7,
        analysisResultJson: rawExtractionJson,
        analysisContractVersion: "event_evidence_v2",
        analysisIsEvent: true,
        analysisModel: "gpt-5-mini-2025-08-07",
        createdAt: 1,
        updatedAt: 2,
      },
    ],
    venues: [
      {
        _id: "venue-physical-hall",
        _creationTime: 1,
        name: "QA Physical Hall",
        instagramHandle: "qa_physical_hall",
        category: "music",
        scrapeActive: true,
        publicStatus: "published",
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    savedEvents: [],
    userSavedEvents: [],
    eventAuditLog: [],
  };
}

class QueryBuilder {
  constructor(rows) {
    this.rows = rows;
  }

  withIndex(_name, configure) {
    const predicates = [];
    const q = {
      eq(field, value) {
        predicates.push((row) => String(row[field]) === String(value));
        return q;
      },
      gte() {
        return q;
      },
      lt() {
        return q;
      },
    };
    configure(q);
    this.rows = this.rows.filter((row) =>
      predicates.every((predicate) => predicate(row)),
    );
    return this;
  }

  async collect() {
    return this.rows.map((row) => structuredClone(row));
  }

  async take(count) {
    return this.rows.slice(0, count).map((row) => structuredClone(row));
  }
}

function createTransactionalHarness(initial = readyFixture()) {
  let committed = structuredClone(initial);

  function rowsByTable(state, table) {
    return state[table] ?? [];
  }

  function rowById(state, id) {
    for (const rows of Object.values(state)) {
      const row = rows.find((candidate) => String(candidate._id) === String(id));
      if (row) return row;
    }
    return null;
  }

  async function run(mutation, args, identity = null) {
    const staged = structuredClone(committed);
    const ctx = {
      auth: { getUserIdentity: async () => identity },
      db: {
        async get(id) {
          return structuredClone(rowById(staged, id));
        },
        query(table) {
          return new QueryBuilder(
            rowsByTable(staged, table).map((row) => structuredClone(row)),
          );
        },
        async patch(id, patch) {
          const row = rowById(staged, id);
          if (!row) throw new Error(`Missing mock row ${String(id)}.`);
          Object.assign(row, structuredClone(patch));
        },
        async insert(table, value) {
          const rows = rowsByTable(staged, table);
          if (!staged[table]) staged[table] = rows;
          const id = `qa-${table}-${rows.length + 1}`;
          rows.push({ _id: id, ...structuredClone(value) });
          return id;
        },
      },
    };
    const result = await mutation._handler(ctx, args);
    committed = staged;
    return result;
  }

  return {
    run,
    snapshot: () => structuredClone(committed),
    mutate(callback) {
      callback(committed);
    },
  };
}

function targetPatch() {
  return {
    status: "approved",
    normalizedFieldsJson: approvedNormalizedFields({
      title: "Relaxed Approval Event",
      venue: "QA Physical Hall",
      artists: ["@qa_artist"],
      sourceOccurrenceKey: TARGET_KEY,
    }),
    sourceConflictFields: [],
    dateEvidenceText: EVENT_DATE,
    dateEvidenceSource: "caption",
    dateEvidenceIsRelative: false,
    dateEvidenceResolvedDate: EVENT_DATE,
    venue: "QA Physical Hall",
    artists: ["@qa_artist"],
  };
}

function applyArgs(snapshot, overrides = {}) {
  const event = snapshot.events.find((candidate) => candidate._id === TARGET_ID);
  const receipt = snapshot.instagramSourceOccurrenceReceipts[0];
  return {
    sourceIdentity: SOURCE_IDENTITY,
    expectedReceiptId: receipt._id,
    expectedReceiptUpdatedAt: receipt.updatedAt,
    expectedSourceFingerprint: receipt.sourceFingerprint,
    items: [
      {
        id: event._id,
        expectedUpdatedAt: event.updatedAt,
        expectedNormalizedFieldsJson: event.normalizedFieldsJson,
        patch: targetPatch(),
      },
    ],
    serviceSecret: SERVICE_SECRET,
    ...overrides,
  };
}

function rollbackArgs(snapshot, originalTarget, overrides = {}) {
  const event = snapshot.events.find((candidate) => candidate._id === TARGET_ID);
  const receipt = snapshot.instagramSourceOccurrenceReceipts[0];
  return {
    sourceIdentity: SOURCE_IDENTITY,
    expectedReceiptId: receipt._id,
    expectedReceiptUpdatedAt: receipt.updatedAt,
    expectedSourceFingerprint: receipt.sourceFingerprint,
    items: [
      {
        id: event._id,
        expectedUpdatedAt: event.updatedAt,
        expectedNormalizedFieldsJson: event.normalizedFieldsJson,
        patch: {
          status: "pending",
          normalizedFieldsJson: originalTarget.normalizedFieldsJson,
          sourceConflictFields: originalTarget.sourceConflictFields,
          dateEvidenceText: originalTarget.dateEvidenceText,
          dateEvidenceSource: originalTarget.dateEvidenceSource,
          dateEvidenceIsRelative: originalTarget.dateEvidenceIsRelative,
          dateEvidenceResolvedDate: originalTarget.dateEvidenceResolvedDate,
          venue: originalTarget.venue,
          artists: originalTarget.artists,
        },
      },
    ],
    serviceSecret: SERVICE_SECRET,
    ...overrides,
  };
}

const previousCronSecret = process.env.CRON_SECRET;
const previousAdminSubjects = process.env.ADMIN_CLERK_USER_IDS;
const originalDateNow = Date.now;
process.env.CRON_SECRET = SERVICE_SECRET;
process.env.ADMIN_CLERK_USER_IDS = ADMIN_SUBJECT;
let clock = 50_000;
Date.now = () => ++clock;

const rangeEvidenceText = "od 26. avgusta do 12. septembra 2026.";
const rangeRawExtractionJson = JSON.stringify({
  extraction_contract_version: "event_evidence_v2",
  date_evidence: {
    exact_text: rangeEvidenceText,
    source: "poster",
    is_relative: false,
    resolved_date: "2026-09-01",
  },
  schedule_entries: [],
});
const rangeEvent = {
  _id: "event-range-correction",
  date: "2026-09-12",
  dateEvidenceText: rangeEvidenceText,
  dateEvidenceSource: "poster",
  dateEvidenceIsRelative: false,
  dateEvidenceResolvedDate: "2026-09-01",
  rawExtractionJson: rangeRawExtractionJson,
};
const rangeCorrectionItem = {
  id: rangeEvent._id,
  expectedUpdatedAt: 1,
  expectedNormalizedFieldsJson: "{}",
  patch: {
    status: "approved",
    normalizedFieldsJson: "{}",
    dateEvidenceText: rangeEvidenceText,
    dateEvidenceSource: "poster",
    dateEvidenceIsRelative: false,
    dateEvidenceResolvedDate: rangeEvent.date,
  },
};
assert.doesNotThrow(() =>
  assertEventEvidencePolicyDateEvidenceTransitionForTesting(
    rangeEvent,
    rangeCorrectionItem,
  ),
);
assert.doesNotThrow(() =>
  assertEventEvidencePolicyDateEvidenceTransitionForTesting(
    {
      ...rangeEvent,
      dateEvidenceResolvedDate: rangeEvent.date,
    },
    {
      ...rangeCorrectionItem,
      patch: {
        ...rangeCorrectionItem.patch,
        status: "pending",
        dateEvidenceResolvedDate: "2026-09-01",
      },
    },
  ),
  "The exact range correction must also be rollback-safe.",
);
for (const patch of [
  { dateEvidenceResolvedDate: "2026-09-13" },
  { dateEvidenceText: "od 26. avgusta do 13. septembra 2026." },
  { dateEvidenceIsRelative: true },
]) {
  assert.throws(
    () =>
      assertEventEvidencePolicyDateEvidenceTransitionForTesting(
        rangeEvent,
        {
          ...rangeCorrectionItem,
          patch: { ...rangeCorrectionItem.patch, ...patch },
        },
      ),
    /date(?:-range correction| evidence)/i,
    "Only the source-bound occurrence resolution inside the exact raw range may change.",
  );
}

const fallbackTitleEventDate = "2026-08-23";
const fallbackTitleEventType = "nightlife";
const fallbackTitleOriginalVenue = "Promoter Account";
const fallbackTitleNextVenue = "Physical Venue";
const fallbackTitleOriginal = buildUnnamedScheduleFallbackTitle({
  eventType: fallbackTitleEventType,
  venue: fallbackTitleOriginalVenue,
  isoDate: fallbackTitleEventDate,
});
const fallbackTitleNext = buildUnnamedScheduleFallbackTitle({
  eventType: fallbackTitleEventType,
  venue: fallbackTitleNextVenue,
  isoDate: fallbackTitleEventDate,
});
const fallbackTitleEvent = {
  _id: "event-fallback-title-correction",
  title: fallbackTitleOriginal,
  date: fallbackTitleEventDate,
  eventType: fallbackTitleEventType,
  venue: fallbackTitleOriginalVenue,
  normalizedFieldsJson: JSON.stringify({
    title: fallbackTitleOriginal,
    titleUsedFallback: true,
    titleSource: "unnamed_schedule_fallback",
    fallbackIdentityPolicyVersion: 1,
  }),
};
assert.doesNotThrow(() =>
  assertEventEvidencePolicyTitleTransitionForTesting(fallbackTitleEvent, {
    id: fallbackTitleEvent._id,
    expectedUpdatedAt: 1,
    expectedNormalizedFieldsJson: fallbackTitleEvent.normalizedFieldsJson,
    patch: {
      title: fallbackTitleNext,
      venue: fallbackTitleNextVenue,
      normalizedFieldsJson: JSON.stringify({
        title: fallbackTitleNext,
        titleUsedFallback: true,
        titleSource: "unnamed_schedule_fallback",
        fallbackIdentityPolicyVersion: 1,
      }),
    },
  }),
);
for (const [currentTitleUsedFallback, nextTitleUsedFallback] of [
  [false, true],
  [true, false],
]) {
  const event = {
    ...fallbackTitleEvent,
    normalizedFieldsJson: JSON.stringify({
      title: fallbackTitleEvent.title,
      titleUsedFallback: currentTitleUsedFallback,
      titleSource: currentTitleUsedFallback ? "unnamed_schedule_fallback" : "model",
      fallbackIdentityPolicyVersion: currentTitleUsedFallback ? 1 : undefined,
    }),
  };
  assert.throws(
    () =>
      assertEventEvidencePolicyTitleTransitionForTesting(event, {
        id: event._id,
        expectedUpdatedAt: 1,
        expectedNormalizedFieldsJson: event.normalizedFieldsJson,
        patch: {
          title: "Forged Headliner",
          normalizedFieldsJson: JSON.stringify({
            title: "Forged Headliner",
            titleUsedFallback: nextTitleUsedFallback,
            titleSource: nextTitleUsedFallback ? "unnamed_schedule_fallback" : "model",
            fallbackIdentityPolicyVersion: nextTitleUsedFallback ? 1 : undefined,
          }),
        },
      }),
    /only deterministic unnamed fallback titles/i,
  );
}

try {
  const serviceOnly = createTransactionalHarness();
  const serviceOnlyBefore = serviceOnly.snapshot();
  await assert.rejects(
    () =>
      serviceOnly.run(
        reprocessPendingEventEvidencePolicyBatch,
        { ...applyArgs(serviceOnlyBefore), serviceSecret: "wrong-secret" },
        { subject: ADMIN_SUBJECT },
      ),
    /requires service authentication/i,
  );
  assert.deepEqual(serviceOnly.snapshot(), serviceOnlyBefore);

  for (const items of [
    [],
    Array.from({ length: 17 }, (_, index) => ({
      id: `bounded-${index}`,
      expectedUpdatedAt: 1,
      expectedNormalizedFieldsJson: "{}",
      patch: { status: "approved", normalizedFieldsJson: "{}" },
    })),
  ]) {
    const bounded = createTransactionalHarness();
    const before = bounded.snapshot();
    await assert.rejects(
      () =>
        bounded.run(reprocessPendingEventEvidencePolicyBatch, {
          ...applyArgs(before),
          items,
        }),
      /batch is invalid/i,
    );
    assert.deepEqual(bounded.snapshot(), before);
  }

  const duplicate = createTransactionalHarness();
  const duplicateBefore = duplicate.snapshot();
  const duplicateItem = applyArgs(duplicateBefore).items[0];
  await assert.rejects(
    () =>
      duplicate.run(reprocessPendingEventEvidencePolicyBatch, {
        ...applyArgs(duplicateBefore),
        items: [duplicateItem, structuredClone(duplicateItem)],
      }),
    /unique event IDs/i,
  );
  assert.deepEqual(duplicate.snapshot(), duplicateBefore);

  for (const override of [
    { expectedReceiptId: "wrong-receipt" },
    { expectedReceiptUpdatedAt: 19_999 },
    { expectedSourceFingerprint: "wrong-fingerprint" },
  ]) {
    const staleReceipt = createTransactionalHarness();
    const before = staleReceipt.snapshot();
    await assert.rejects(
      () =>
        staleReceipt.run(
          reprocessPendingEventEvidencePolicyBatch,
          applyArgs(before, override),
        ),
      /receipt precondition failed/i,
    );
    assert.deepEqual(staleReceipt.snapshot(), before);
  }

  for (const mutateArgs of [
    (args) => {
      args.items[0].expectedUpdatedAt -= 1;
    },
    (args) => {
      args.items[0].expectedNormalizedFieldsJson = "{}";
    },
  ]) {
    const staleEvent = createTransactionalHarness();
    const before = staleEvent.snapshot();
    const args = applyArgs(before);
    mutateArgs(args);
    await assert.rejects(
      () => staleEvent.run(reprocessPendingEventEvidencePolicyBatch, args),
      /event precondition failed/i,
    );
    assert.deepEqual(staleEvent.snapshot(), before);
  }

  const wrongStatusFixture = readyFixture();
  wrongStatusFixture.events.find((event) => event._id === TARGET_ID).status = "approved";
  const wrongStatus = createTransactionalHarness(wrongStatusFixture);
  const wrongStatusBefore = wrongStatus.snapshot();
  await assert.rejects(
    () =>
      wrongStatus.run(
        reprocessPendingEventEvidencePolicyBatch,
        applyArgs(wrongStatusBefore),
      ),
    /event precondition failed/i,
  );
  assert.deepEqual(wrongStatus.snapshot(), wrongStatusBefore);

  const namedTitleChange = createTransactionalHarness();
  const namedTitleBefore = namedTitleChange.snapshot();
  const namedTitleArgs = applyArgs(namedTitleBefore);
  namedTitleArgs.items[0].patch.title = "Forged Named Event";
  const namedTitleNormalized = JSON.parse(
    namedTitleArgs.items[0].patch.normalizedFieldsJson,
  );
  namedTitleNormalized.title = "Forged Named Event";
  namedTitleArgs.items[0].patch.normalizedFieldsJson = JSON.stringify(
    namedTitleNormalized,
  );
  await assert.rejects(
    () =>
      namedTitleChange.run(
        reprocessPendingEventEvidencePolicyBatch,
        namedTitleArgs,
      ),
    /only deterministic unnamed fallback titles/i,
  );
  assert.deepEqual(namedTitleChange.snapshot(), namedTitleBefore);

  const forgedFallbackFixture = readyFixture();
  const forgedFallbackTarget = forgedFallbackFixture.events.find(
    (event) => event._id === TARGET_ID,
  );
  const forgedFallbackSourceLine =
    `${EVENT_DATE} at 20:00 at QA Physical Hall`;
  const forgedFallbackRawExtraction = JSON.stringify({
    extraction_contract_version: "event_evidence_v2",
    source_conflicts: [benignVenueConflict],
    schedule_entries: [
      {
        date: EVENT_DATE,
        time: EVENT_TIME,
        venue: "QA Physical Hall",
        title: "",
        artists: [],
        source_text: forgedFallbackSourceLine,
        date_evidence: {
          exact_text: EVENT_DATE,
          source: "caption",
          is_relative: false,
          resolved_date: EVENT_DATE,
        },
      },
    ],
  });
  forgedFallbackTarget.artists = [];
  forgedFallbackTarget.eventType = "nightlife";
  forgedFallbackTarget.title = buildUnnamedScheduleFallbackTitle({
    eventType: forgedFallbackTarget.eventType,
    venue: forgedFallbackTarget.venue,
    isoDate: forgedFallbackTarget.date,
  });
  forgedFallbackTarget.rawExtractionJson = forgedFallbackRawExtraction;
  const forgedFallbackCurrentFields = JSON.parse(
    oldNormalizedFields({
      title: forgedFallbackTarget.title,
      venue: forgedFallbackTarget.venue,
      artists: [],
      sourceOccurrenceKey: TARGET_KEY,
    }),
  );
  forgedFallbackCurrentFields.titleUsedFallback = true;
  forgedFallbackCurrentFields.titleSource = "unnamed_schedule_fallback";
  forgedFallbackCurrentFields.fallbackIdentityPolicyVersion = 1;
  forgedFallbackTarget.normalizedFieldsJson = JSON.stringify(
    forgedFallbackCurrentFields,
  );
  forgedFallbackFixture.instagramSourceOccurrenceReceipts[0].expectedOccurrences =
    forgedFallbackFixture.instagramSourceOccurrenceReceipts[0].expectedOccurrences.map(
      (occurrence) =>
        occurrence.key === TARGET_KEY
          ? expectedOccurrence(forgedFallbackTarget)
          : occurrence,
    );
  forgedFallbackFixture.scrapedPosts[0].analysisResultJson =
    forgedFallbackRawExtraction;
  const forgedFallback = createTransactionalHarness(forgedFallbackFixture);
  const forgedFallbackBefore = forgedFallback.snapshot();
  const forgedFallbackArgs = applyArgs(forgedFallbackBefore);
  const forgedFallbackApprovedFields = JSON.parse(
    approvedNormalizedFields({
      title: "Forged Headliner",
      venue: "QA Physical Hall",
      artists: [],
      sourceOccurrenceKey: TARGET_KEY,
    }),
  );
  Object.assign(forgedFallbackApprovedFields, {
    titleUsedFallback: true,
    titleSource: "unnamed_schedule_fallback",
    fallbackIdentityPolicyVersion: 1,
    splitSourceLine: forgedFallbackSourceLine,
    rowSourceText: forgedFallbackSourceLine,
  });
  Object.assign(forgedFallbackArgs.items[0].patch, {
    title: "Forged Headliner",
    artists: [],
    normalizedFieldsJson: JSON.stringify(forgedFallbackApprovedFields),
  });
  await assert.rejects(
    () =>
      forgedFallback.run(
        reprocessPendingEventEvidencePolicyBatch,
        forgedFallbackArgs,
      ),
    /deterministic unnamed fallback|approv|source-ground/i,
  );
  assert.deepEqual(forgedFallback.snapshot(), forgedFallbackBefore);

  const validFallback = createTransactionalHarness(
    structuredClone(forgedFallbackFixture),
  );
  const validFallbackBefore = validFallback.snapshot();
  const validFallbackOriginalTarget = validFallbackBefore.events.find(
    (event) => event._id === TARGET_ID,
  );
  const validFallbackTitle = buildUnnamedScheduleFallbackTitle({
    eventType: validFallbackOriginalTarget.eventType,
    venue: "QA Physical Hall",
    isoDate: validFallbackOriginalTarget.date,
  });
  const validFallbackArgs = applyArgs(validFallbackBefore);
  const validFallbackApprovedFields = JSON.parse(
    approvedNormalizedFields({
      title: validFallbackTitle,
      venue: "QA Physical Hall",
      artists: [],
      sourceOccurrenceKey: TARGET_KEY,
    }),
  );
  Object.assign(validFallbackApprovedFields, {
    titleUsedFallback: true,
    titleSource: "unnamed_schedule_fallback",
    fallbackIdentityPolicyVersion: 1,
    splitSourceLine: forgedFallbackSourceLine,
    rowSourceText: forgedFallbackSourceLine,
  });
  Object.assign(validFallbackArgs.items[0].patch, {
    title: validFallbackTitle,
    artists: [],
    normalizedFieldsJson: JSON.stringify(validFallbackApprovedFields),
  });
  const validFallbackApplied = await validFallback.run(
    reprocessPendingEventEvidencePolicyBatch,
    validFallbackArgs,
  );
  const validFallbackAfterApply = validFallback.snapshot();
  const validFallbackAppliedTarget = validFallbackAfterApply.events.find(
    (event) => event._id === TARGET_ID,
  );
  const validFallbackAppliedReceipt =
    validFallbackAfterApply.instagramSourceOccurrenceReceipts[0];
  assert.equal(validFallbackAppliedTarget.title, validFallbackTitle);
  assert.equal(
    validFallbackAppliedReceipt.expectedOccurrences.find(
      (occurrence) => occurrence.key === TARGET_KEY,
    ).title,
    validFallbackTitle,
  );
  const forgedFallbackRollbackArgs = rollbackArgs(
    validFallbackAfterApply,
    validFallbackOriginalTarget,
  );
  forgedFallbackRollbackArgs.items[0].patch.title = "Forged Rollback Title";
  const forgedFallbackRollbackFields = JSON.parse(
    forgedFallbackRollbackArgs.items[0].patch.normalizedFieldsJson,
  );
  forgedFallbackRollbackFields.title = "Forged Rollback Title";
  forgedFallbackRollbackArgs.items[0].patch.normalizedFieldsJson = JSON.stringify(
    forgedFallbackRollbackFields,
  );
  await assert.rejects(
    () =>
      validFallback.run(
        rollbackEventEvidencePolicyBatch,
        forgedFallbackRollbackArgs,
      ),
    /deterministic unnamed fallback/i,
  );
  assert.deepEqual(validFallback.snapshot(), validFallbackAfterApply);
  const validFallbackRollbackArgs = rollbackArgs(
    validFallbackAfterApply,
    validFallbackOriginalTarget,
  );
  validFallbackRollbackArgs.items[0].patch.title =
    validFallbackOriginalTarget.title;
  const validFallbackRolledBack = await validFallback.run(
    rollbackEventEvidencePolicyBatch,
    validFallbackRollbackArgs,
  );
  assert.equal(validFallbackApplied.updatedCount, 1);
  assert.equal(validFallbackRolledBack.updatedCount, 1);
  const validFallbackAfterRollback = validFallback.snapshot();
  assert.equal(
    validFallbackAfterRollback.events.find((event) => event._id === TARGET_ID).title,
    validFallbackOriginalTarget.title,
  );
  assert.equal(
    validFallbackAfterRollback.instagramSourceOccurrenceReceipts[0].expectedOccurrences.find(
      (occurrence) => occurrence.key === TARGET_KEY,
    ).title,
    validFallbackOriginalTarget.title,
  );

  for (const mutateFixture of [
    (fixture) => {
      fixture.instagramEventSources.push({
        ...fixture.instagramEventSources[0],
        _id: "duplicate-target-link",
      });
    },
    (fixture) => {
      fixture.instagramEventSources[0].sourceIdentity = "wrong-source";
    },
    (fixture) => {
      fixture.instagramEventSources[0].sourceFingerprint = "wrong-fingerprint";
    },
    (fixture) => {
      fixture.instagramSourceOccurrenceReceipts[0].expectedOccurrences =
        fixture.instagramSourceOccurrenceReceipts[0].expectedOccurrences.filter(
          (occurrence) => occurrence.key !== TARGET_KEY,
        );
    },
    (fixture) => {
      fixture.instagramSourceOccurrenceReceipts[0].satisfiedOccurrences.find(
        (occurrence) => occurrence.key === TARGET_KEY,
      ).eventId = SIBLING_ID;
    },
  ]) {
    const fixture = readyFixture();
    mutateFixture(fixture);
    const binding = createTransactionalHarness(fixture);
    const before = binding.snapshot();
    await assert.rejects(
      () =>
        binding.run(
          reprocessPendingEventEvidencePolicyBatch,
          applyArgs(before),
        ),
      /(?:occurrence precondition failed|complete unique occurrence receipt)/i,
    );
    assert.deepEqual(binding.snapshot(), before);
  }

  const atomicFixture = readyFixture();
  const atomicSibling = atomicFixture.events.find((event) => event._id === SIBLING_ID);
  atomicSibling.normalizedFieldsJson = oldNormalizedFields({
    title: "Drifted Sibling",
    venue: atomicSibling.venue,
    artists: atomicSibling.artists,
    sourceOccurrenceKey: SIBLING_KEY,
  });
  const atomic = createTransactionalHarness(atomicFixture);
  const atomicBefore = atomic.snapshot();
  await assert.rejects(
    () =>
      atomic.run(
        reprocessPendingEventEvidencePolicyBatch,
        applyArgs(atomicBefore),
      ),
    /invalidate a receipt sibling/i,
  );
  assert.deepEqual(
    atomic.snapshot(),
    atomicBefore,
    "A sibling failure after staged event/audit writes must roll back the whole transaction.",
  );

  const lifecycle = createTransactionalHarness();
  const original = lifecycle.snapshot();
  const originalTarget = original.events.find((event) => event._id === TARGET_ID);
  const originalSibling = original.events.find((event) => event._id === SIBLING_ID);
  const originalReceipt = original.instagramSourceOccurrenceReceipts[0];
  const applied = await lifecycle.run(
    reprocessPendingEventEvidencePolicyBatch,
    applyArgs(original),
  );
  assert.equal(applied.updatedCount, 1);
  assert.deepEqual(applied.eventIds, [TARGET_ID]);
  assert.equal(applied.eventUpdatedAts.length, 1);
  assert.ok(applied.eventUpdatedAts[0].updatedAt > originalTarget.updatedAt);
  assert.ok(applied.receiptUpdatedAt > originalReceipt.updatedAt);

  const afterApply = lifecycle.snapshot();
  const appliedTarget = afterApply.events.find((event) => event._id === TARGET_ID);
  const appliedSibling = afterApply.events.find((event) => event._id === SIBLING_ID);
  const appliedReceipt = afterApply.instagramSourceOccurrenceReceipts[0];
  assert.equal(appliedTarget.status, "approved");
  assert.equal(appliedTarget.venue, "QA Physical Hall");
  assert.deepEqual(appliedTarget.artists, ["@qa_artist"]);
  assert.deepEqual(appliedTarget.sourceConflictFields, []);
  assert.equal(appliedTarget.venueId, "venue-physical-hall");
  assert.deepEqual(appliedSibling, originalSibling);
  assert.deepEqual(
    appliedReceipt.expectedOccurrences.find((item) => item.key === TARGET_KEY),
    expectedOccurrence(appliedTarget),
  );
  assert.deepEqual(
    appliedReceipt.expectedOccurrences.find((item) => item.key === SIBLING_KEY),
    originalReceipt.expectedOccurrences.find((item) => item.key === SIBLING_KEY),
  );
  assert.deepEqual(appliedReceipt.satisfiedOccurrences, originalReceipt.satisfiedOccurrences);
  assert.equal(afterApply.eventAuditLog.length, 1);

  lifecycle.mutate((state) => {
    state.savedEvents.push({
      _id: "saved-target",
      userId: "qa-user",
      eventId: TARGET_ID,
      createdAt: 1,
    });
  });
  const savedBeforeRollback = lifecycle.snapshot();
  await assert.rejects(
    () =>
      lifecycle.run(
        rollbackEventEvidencePolicyBatch,
        rollbackArgs(savedBeforeRollback, originalTarget),
      ),
    /rollback refused for a saved event/i,
  );
  assert.deepEqual(lifecycle.snapshot(), savedBeforeRollback);

  lifecycle.mutate((state) => {
    state.savedEvents.length = 0;
  });
  const beforeRollback = lifecycle.snapshot();
  const rolledBack = await lifecycle.run(
    rollbackEventEvidencePolicyBatch,
    rollbackArgs(beforeRollback, originalTarget),
  );
  assert.equal(rolledBack.updatedCount, 1);
  assert.deepEqual(rolledBack.eventIds, [TARGET_ID]);
  const afterRollback = lifecycle.snapshot();
  const rolledBackTarget = afterRollback.events.find((event) => event._id === TARGET_ID);
  const rolledBackReceipt = afterRollback.instagramSourceOccurrenceReceipts[0];
  assert.equal(rolledBackTarget.status, "pending");
  assert.equal(rolledBackTarget.venue, originalTarget.venue);
  assert.deepEqual(rolledBackTarget.artists, originalTarget.artists);
  assert.equal(rolledBackTarget.normalizedFieldsJson, originalTarget.normalizedFieldsJson);
  assert.deepEqual(
    rolledBackReceipt.expectedOccurrences,
    originalReceipt.expectedOccurrences,
  );
  assert.deepEqual(
    rolledBackReceipt.satisfiedOccurrences,
    originalReceipt.satisfiedOccurrences,
  );
  assert.equal(afterRollback.eventAuditLog.length, 2);
} finally {
  Date.now = originalDateNow;
  if (previousCronSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = previousCronSecret;
  if (previousAdminSubjects === undefined) delete process.env.ADMIN_CLERK_USER_IDS;
  else process.env.ADMIN_CLERK_USER_IDS = previousAdminSubjects;
}

function rollbackGroup(sourceIdentity, index) {
  return {
    sourceIdentity,
    expectedReceiptId: `receipt-${sourceIdentity}`,
    expectedSourceFingerprint: `fingerprint-${sourceIdentity}`,
    items: [
      {
        rollbackItem: {
          id: `event-${sourceIdentity}`,
          expectedNormalizedFieldsJson: `approved-${sourceIdentity}`,
          patch: {
            status: "pending",
            normalizedFieldsJson: `pending-${sourceIdentity}`,
            sourceConflictFields: [],
            dateEvidenceText: EVENT_DATE,
            dateEvidenceSource: "caption",
            dateEvidenceIsRelative: false,
            dateEvidenceResolvedDate: EVENT_DATE,
          },
        },
      },
    ],
    result: {
      receiptUpdatedAt: 60_000 + index,
      eventUpdatedAts: [
        {
          id: `event-${sourceIdentity}`,
          updatedAt: 70_000 + index,
        },
      ],
    },
  };
}

const rollbackGroups = [
  rollbackGroup("A", 1),
  rollbackGroup("B", 2),
  rollbackGroup("C", 3),
];
const firstRollbackAttempts = [];
const firstProgressSnapshots = [];
const rollbackClient = {
  async query(_query, args) {
    const group = rollbackGroups.find(
      (candidate) => candidate.sourceIdentity === args.sourceIdentity,
    );
    return {
      _id: group.expectedReceiptId,
      sourceFingerprint: group.expectedSourceFingerprint,
      updatedAt: group.result.receiptUpdatedAt,
    };
  },
  async mutation(_mutation, args) {
    firstRollbackAttempts.push({
      sourceIdentity: args.sourceIdentity,
      expectedUpdatedAt: args.items[0].expectedUpdatedAt,
    });
    if (args.sourceIdentity === "B") {
      throw new Error("QA rollback failure for B.");
    }
    return {
      updatedCount: 1,
      eventIds: [`event-${args.sourceIdentity}`],
    };
  },
};
let firstRollbackError;
try {
  await rollbackAppliedGroups(rollbackClient, SERVICE_SECRET, rollbackGroups, {
    persistProgress: async ({ appliedGroups, outcome }) => {
      firstProgressSnapshots.push({
        outcome: structuredClone(outcome),
        statuses: appliedGroups.map((group) => group.rollback?.status ?? null),
      });
    },
  });
} catch (error) {
  firstRollbackError = error;
}
assert.ok(firstRollbackError instanceof AggregateError);
assert.deepEqual(
  firstRollbackAttempts.map(({ sourceIdentity }) => sourceIdentity),
  ["C", "B", "A"],
  "Rollback must keep moving in reverse order after an intermediate group fails.",
);
assert.deepEqual(
  firstRollbackAttempts.map(({ expectedUpdatedAt }) => expectedUpdatedAt),
  [70_003, 70_002, 70_001],
);
assert.deepEqual(
  firstProgressSnapshots.map(({ outcome }) => [outcome.sourceIdentity, outcome.status]),
  [
    ["C", "rolled_back"],
    ["B", "failed"],
    ["A", "rolled_back"],
  ],
  "Every attempted group outcome must be persisted.",
);
assert.deepEqual(
  firstProgressSnapshots.map(({ statuses }) => statuses),
  [
    [null, null, "rolled_back"],
    [null, "failed", "rolled_back"],
    ["rolled_back", "failed", "rolled_back"],
  ],
  "Each progress write must carry every group outcome known at that point.",
);
assert.deepEqual(
  rollbackGroups.map((group) => group.rollback.status),
  ["rolled_back", "failed", "rolled_back"],
);
assert.equal(firstRollbackError.rollbackSummary.completedGroupCount, 2);
assert.equal(firstRollbackError.rollbackSummary.totalGroupCount, 3);
assert.deepEqual(
  firstRollbackError.rollbackSummary.failures.map(({ sourceIdentity }) => sourceIdentity),
  ["B"],
);

const retryRollbackAttempts = [];
const retryProgressSnapshots = [];
const retrySummary = await rollbackAppliedGroups(
  {
    ...rollbackClient,
    async mutation(_mutation, args) {
      retryRollbackAttempts.push(args.sourceIdentity);
      return {
        updatedCount: 1,
        eventIds: [`event-${args.sourceIdentity}`],
      };
    },
  },
  SERVICE_SECRET,
  rollbackGroups,
  {
    persistProgress: async ({ appliedGroups, outcome }) => {
      retryProgressSnapshots.push({
        outcome: structuredClone(outcome),
        statuses: appliedGroups.map((group) => group.rollback?.status ?? null),
      });
    },
  },
);
assert.deepEqual(
  retryRollbackAttempts,
  ["B"],
  "A retry must skip groups already durably marked rolled back.",
);
assert.deepEqual(retrySummary.skippedSourceIdentities, ["C", "A"]);
assert.equal(retrySummary.completedGroupCount, 3);
assert.equal(retrySummary.totalGroupCount, 3);
assert.deepEqual(
  retryProgressSnapshots.map(({ outcome }) => [outcome.sourceIdentity, outcome.status]),
  [["B", "rolled_back"]],
);
assert.deepEqual(retryProgressSnapshots[0].statuses, [
  "rolled_back",
  "rolled_back",
  "rolled_back",
]);
assert.deepEqual(
  rollbackGroups.map((group) => group.rollback.status),
  ["rolled_back", "rolled_back", "rolled_back"],
);

const eventsSource = readFileSync(
  new URL("../convex/events.ts", import.meta.url),
  "utf8",
);
const runnerSource = readFileSync(
  new URL("./reprocess-pending-event-evidence-policy.mjs", import.meta.url),
  "utf8",
);
const transitionArgsSource = eventsSource.match(
  /const eventEvidencePolicyTransitionArgs = \{([\s\S]*?)\n\};/,
)?.[1];
assert.ok(transitionArgsSource, "The replay transition validator must exist.");
assert.match(transitionArgsSource, /serviceSecret:\s*v\.string\(\)/);
assert.match(eventsSource, /MAX_EVENT_EVIDENCE_POLICY_REPROCESS_BATCH_SIZE = 16/);
assert.match(eventsSource, /authorization\.kind !== "service"/);
assert.match(eventsSource, /returns: eventEvidencePolicyTransitionResult/);
assert.match(eventsSource, /withIndex\("by_sourceIdentity"/);
assert.match(eventsSource, /withIndex\("by_event"/);
assert.match(eventsSource, /Event-evidence policy rollback refused for a saved event/);

const parseArgsMatch = runnerSource.match(
  /(function parseArgs\(argv\) \{[\s\S]*?\n\})\n\nfunction parseRecord/,
);
assert.ok(parseArgsMatch, "The replay runner argument parser must be testable.");
const parseArgs = Function(
  "BACKUP_ROOT",
  `"use strict"; ${parseArgsMatch[1]}; return parseArgs;`,
)("/root/backups/ig-event-moderation-policy-20260822");
assert.deepEqual(parseArgs([]), {
  apply: false,
  rollbackManifest: null,
  expectedEligibleCount: null,
  expectedManifestSha256: null,
  expectedTargetCount: null,
  backupRoot: "/root/backups/ig-event-moderation-policy-20260822",
});
assert.deepEqual(
  parseArgs([
    "--apply",
    "--expect-target-count",
    "29",
    "--expect-eligible-count",
    "27",
    "--expect-manifest-sha256",
    "a".repeat(64),
    "--backup-root",
    "/root/qa-backup",
  ]),
  {
    apply: true,
    rollbackManifest: null,
    expectedEligibleCount: 27,
    expectedManifestSha256: "a".repeat(64),
    expectedTargetCount: 29,
    backupRoot: "/root/qa-backup",
  },
);
assert.throws(
  () => parseArgs(["--apply", "--rollback-manifest", "/root/rollback.json"]),
  /either --apply or --rollback-manifest/i,
);
assert.throws(() => parseArgs(["--unknown"]), /unknown argument/i);

const fallbackForwardPatch = buildForwardPatch(
  {
    title: "Sunday Night at Promoter Account",
    normalizedFieldsJson: JSON.stringify({
      titleUsedFallback: true,
      titleSource: "unnamed_schedule_fallback",
    }),
  },
  {
    title: "Sunday Night at Physical Venue",
    normalizedFieldsJson: JSON.stringify({
      titleUsedFallback: true,
      titleSource: "unnamed_schedule_fallback",
    }),
  },
);
assert.deepEqual(fallbackForwardPatch.unsupportedPublicChanges, []);
assert.equal(fallbackForwardPatch.patch.title, "Sunday Night at Physical Venue");
assert.deepEqual(fallbackForwardPatch.changedPublicFields, ["title"]);
const namedForwardPatch = buildForwardPatch(
  {
    title: "Named Event",
    normalizedFieldsJson: JSON.stringify({
      titleUsedFallback: false,
      titleSource: "model",
    }),
  },
  {
    title: "Different Named Event",
    normalizedFieldsJson: JSON.stringify({
      titleUsedFallback: false,
      titleSource: "model",
    }),
  },
);
assert.deepEqual(namedForwardPatch.unsupportedPublicChanges, ["title"]);
assert.equal(namedForwardPatch.patch, null);

const dryRunGate = runnerSource.indexOf("if (!options.apply)");
const applyAdmission = runnerSource.indexOf("Apply admission failed");
const backupWrite = runnerSource.indexOf("const backup = createExclusiveJsonFile");
const firstApplyMutation = runnerSource.indexOf("client.mutation(applyPolicyMutation");
assert.ok(dryRunGate >= 0 && dryRunGate < applyAdmission);
assert.ok(applyAdmission < backupWrite && backupWrite < firstApplyMutation);
for (const admissionFence of [
  "options.expectedTargetCount !== targets.length",
  "options.expectedEligibleCount !== eligible.length",
  "options.expectedManifestSha256 !== manifestSha256",
  "targets.length !== TARGET_EVENT_COUNT",
  'summary.longPlaySourceRole !== "promoter"',
  "!options.backupRoot",
]) {
  assert.match(runnerSource, new RegExp(admissionFence.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
}
assert.match(runnerSource, /const TARGET_EVENT_COUNT = 29/);
assert.match(
  runnerSource,
  /rollbackAppliedGroups\(client, serviceSecret, appliedGroups, \{/,
);
assert.doesNotMatch(
  runnerSource,
  /extractEventDataWithOpenAi|runApify|client\.action\(/,
  "The cached replay runner must not call Apify, OpenAI, or Convex actions.",
);

console.log(
  JSON.stringify({
    status: "ok",
    suite: "event-evidence-policy-reprocess",
    serviceOnly: true,
    maxBatchSize: 16,
    transactionalApplyRollback: true,
    bestEffortReverseRollback: true,
    retrySkipsCompletedRollbackGroups: true,
    runnerDefaultMode: "dry-run",
    apifyCalls: 0,
    openAiCalls: 0,
  }),
);
