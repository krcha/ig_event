import assert from "node:assert/strict";

import { apply, preview } from "../convex/approvedPublicationRepairs.ts";
import { buildInstagramSourceOccurrenceFingerprint } from "../lib/domain/occurrences/source-fingerprint.ts";
import { evaluatePublicationEligibility } from "../lib/domain/publication/policy.ts";
import {
  evaluateEventPublication,
  isEventPubliclyVisible,
  refreshEventPublicationBatch,
  refreshEventPublicationStates,
  refreshVenuePublicationPage,
} from "../convex/publicationPolicy.ts";

assert.deepEqual(
  evaluatePublicationEligibility({
    canonicalSourceGroundingVerified: true,
    moderationStatus: "approved",
  }),
  {
    policyVersion: 1,
    reason: "canonical_source_grounding_verified",
    state: "publishable",
  },
);
assert.equal(
  evaluatePublicationEligibility({
    canonicalSourceGroundingVerified: true,
    moderationStatus: "pending",
  }).state,
  "hidden",
);
assert.equal(
  evaluatePublicationEligibility({
    canonicalSourceGroundingVerified: true,
    moderationStatus: "approved",
    venuePublic: false,
  }).reason,
  "venue_unavailable",
);
assert.equal(
  evaluatePublicationEligibility({
    canonicalSourceGroundingVerified: false,
    moderationStatus: "approved",
  }).state,
  "pending_verification",
);
assert.equal(
  evaluatePublicationEligibility({
    canonicalSourceGroundingVerified: true,
    moderationStatus: "approved",
    occurrenceComplete: false,
  }).reason,
  "occurrence_incomplete",
);
assert.equal(
  evaluatePublicationEligibility({
    canonicalSourceGroundingVerified: true,
    moderationStatus: "approved",
    venueResolutionStatus: "ambiguous",
  }).reason,
  "venue_ambiguous",
);
assert.equal(
  evaluatePublicationEligibility({
    canonicalSourceGroundingVerified: true,
    moderationStatus: "approved",
    venueResolutionStatus: "unresolved",
  }).reason,
  "venue_unresolved",
);

function makePublicationDb() {
  const venues = new Map([
    [
      "venue-qa",
      {
        _id: "venue-qa",
        name: "QA Venue",
        publicStatus: "published",
        scrapeActive: true,
      },
    ],
  ]);
  const events = new Map(
    ["event-a", "event-b"].map((id) => [
      id,
      {
        _id: id,
        artists: [],
        date: "2026-09-04",
        eventType: "culture",
        status: "approved",
        title: id,
        updatedAt: 1,
        venue: "QA Venue",
        venueId: "venue-qa",
      },
    ]),
  );
  const sourceOccurrences = new Map([
    [
      "occurrence-a",
      {
        _id: "occurrence-a",
        canonicalEventId: "event-a",
        sourceIdentity: "source-1",
        state: "satisfied",
        venueResolutionStatus: "resolved",
      },
    ],
    [
      "occurrence-b",
      {
        _id: "occurrence-b",
        canonicalEventId: undefined,
        sourceIdentity: "source-1",
        state: "expected",
        venueResolutionStatus: "resolved",
      },
    ],
  ]);
  const db = {
    async get(id) {
      return events.get(id) ?? sourceOccurrences.get(id) ?? venues.get(id) ?? null;
    },
    async patch(id, patch) {
      const table = events.has(id) ? events : sourceOccurrences;
      table.set(id, { ...table.get(id), ...structuredClone(patch) });
    },
    query(table) {
      assert.equal(table, "sourceOccurrences");
      const filters = {};
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
        async take(limit) {
          return [...sourceOccurrences.values()]
            .filter((row) =>
              Object.entries(filters).every(([field, value]) => row[field] === value),
            )
            .slice(0, limit);
        },
      };
      return chain;
    },
  };
  return { db, events, sourceOccurrences, venues };
}

function makeLegacyVenueRefreshContext() {
  const venue = {
    _id: "venue-hidden",
    instagramHandle: "@legacy_venue",
    name: "Legacy Venue",
    publicStatus: "hidden",
    scrapeActive: true,
  };
  const events = new Map([
    [
      "legacy-by-handle",
      {
        _id: "legacy-by-handle",
        artists: [],
        date: "2026-09-05",
        eventType: "music",
        normalizedFieldsJson: "{}",
        normalizedVenueInstagramHandle: "legacy_venue",
        normalizedVenueIdentity: "legacy venue",
        publicationPolicyVersion: 1,
        publicationReason: "canonical_source_grounding_verified",
        publicationState: "publishable",
        status: "approved",
        title: "Legacy handle event",
        updatedAt: 1,
        venue: "Legacy Venue",
      },
    ],
  ]);
  const scheduled = [];
  const db = {
    async get(id) {
      return id === venue._id ? venue : events.get(id) ?? null;
    },
    async patch(id, patch) {
      events.set(id, { ...events.get(id), ...structuredClone(patch) });
    },
    query(table) {
      const filters = {};
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
        async paginate(options) {
          assert.ok(options.numItems <= 4,
            "Venue publication refresh pages must stay below the read-byte budget.");
          const rows = table === "events" ? [...events.values()] : [];
          return {
            continueCursor: "done",
            isDone: true,
            page: rows.filter((row) =>
              Object.entries(filters).every(([field, value]) => row[field] === value),
            ),
          };
        },
        async take(limit) {
          const rows = table === "events" ? [...events.values()] : [];
          return rows
            .filter((row) =>
              Object.entries(filters).every(([field, value]) => row[field] === value),
            )
            .slice(0, limit);
        },
      };
      return chain;
    },
  };
  return {
    ctx: {
      db,
      scheduler: {
        async runAfter(_delay, _reference, args) {
          scheduled.push(structuredClone(args));
        },
      },
    },
    events,
    scheduled,
    venue,
  };
}

{
  const state = makePublicationDb();
  const incomplete = await evaluateEventPublication(
    { db: state.db },
    state.events.get("event-a"),
  );
  assert.equal(
    incomplete.reason,
    "occurrence_incomplete",
    "An unsatisfied sibling from the same source document must block materialized publication.",
  );

  state.sourceOccurrences.set("occurrence-b", {
    ...state.sourceOccurrences.get("occurrence-b"),
    canonicalEventId: "event-b",
    state: "satisfied",
  });
  await refreshEventPublicationStates(
    { db: state.db },
    ["event-a", "event-b", "event-a"],
  );
  assert.equal(
    state.events.get("event-a").publicationReason,
    "canonical_source_grounding_missing",
    "Completing a later child must refresh the earlier canonical representative.",
  );
  assert.equal(
    state.events.get("event-b").publicationReason,
    "canonical_source_grounding_missing",
  );

  state.sourceOccurrences.set("occurrence-a", {
    ...state.sourceOccurrences.get("occurrence-a"),
    venueResolutionStatus: "unresolved",
  });
  const unresolvedVenue = await evaluateEventPublication(
    { db: state.db },
    state.events.get("event-a"),
  );
  assert.equal(unresolvedVenue.reason, "venue_unresolved");
  state.sourceOccurrences.set("occurrence-a", {
    ...state.sourceOccurrences.get("occurrence-a"),
    venueResolutionStatus: "resolved",
  });

  state.sourceOccurrences.set("occurrence-old", {
    _id: "occurrence-old",
    canonicalEventId: "event-a",
    sourceIdentity: "source-old",
    state: "superseded",
    venueResolutionStatus: "resolved",
  });
  const withSupersededHistory = await evaluateEventPublication(
    { db: state.db },
    state.events.get("event-a"),
  );
  assert.notEqual(
    withSupersededHistory.reason,
    "occurrence_incomplete",
    "Superseded historical claims must not block the current publication state.",
  );

  for (const id of ["occurrence-a", "occurrence-old"]) {
    state.sourceOccurrences.set(id, {
      ...state.sourceOccurrences.get(id),
      state: "superseded",
    });
  }
  const allSuperseded = await evaluateEventPublication(
    { db: state.db },
    state.events.get("event-a"),
  );
  assert.equal(
    allSuperseded.reason,
    "occurrence_incomplete",
    "An all-superseded first-class attachment set must not fall back to legacy publication.",
  );
}

{
  const state = makePublicationDb();
  const sourceIdentity = "large-schedule-source";
  const eventIds = [];
  for (let index = 0; index < 15; index += 1) {
    const eventId = `large-schedule-event-${index}`;
    const occurrenceId = `large-schedule-occurrence-${index}`;
    state.events.set(eventId, {
      ...state.events.get("event-a"),
      _id: eventId,
      description: "e".repeat(27_000),
      title: eventId,
    });
    state.sourceOccurrences.set(occurrenceId, {
      ...state.sourceOccurrences.get("occurrence-a"),
      _id: occurrenceId,
      canonicalEventId: eventId,
      factsJson: "o".repeat(70_000),
      sourceIdentity,
    });
    eventIds.push(eventId);
  }

  const readLimitBytes = 16 * 1024 * 1024;
  let readBytes = 0;
  const countRead = (value) => {
    readBytes += Buffer.byteLength(JSON.stringify(value));
    assert.ok(readBytes < readLimitBytes,
      "A publication refresh transaction exceeded the Convex read-byte budget.");
    return value;
  };
  const get = state.db.get.bind(state.db);
  const query = state.db.query.bind(state.db);
  state.db.get = async (id) => countRead(await get(id));
  state.db.query = (table) => {
    const request = query(table);
    const take = request.take.bind(request);
    request.take = async (limit) => countRead(await take(limit));
    return request;
  };
  const scheduled = [];
  const ctx = {
    db: state.db,
    scheduler: {
      async runAfter(_delay, _reference, args) {
        scheduled.push(structuredClone(args));
      },
    },
  };

  await refreshEventPublicationStates(ctx, eventIds);
  assert.equal(scheduled.length, 1,
    "A fifteen-child source receipt must defer publication evaluation.");
  assert.ok(eventIds.every((id) =>
    state.events.get(id).publicationState === "pending_verification" &&
    state.events.get(id).publicationReason === "derived_state_refresh_deferred"),
  "Deferred representatives must fail closed before scheduling.");
  assert.ok(readBytes < readLimitBytes);

  let batches = 0;
  while (scheduled.length > 0) {
    readBytes = 0;
    const result = await refreshEventPublicationBatch._handler(ctx, scheduled.shift());
    batches += 1;
    assert.ok(result.refreshedCount <= 4,
      "Scheduled refresh must use a bounded publication batch.");
    assert.ok(readBytes < readLimitBytes);
  }
  assert.equal(batches, 4);
  assert.ok(eventIds.every((id) =>
    state.events.get(id).publicationReason !== "derived_state_refresh_deferred"),
  "Every representative must eventually leave the deferred state.");
}

{
  const completeBindingState = {
    completedAt: 1,
    errorCount: 0,
    isDone: true,
    key: "event-venue-bindings-v1",
    mismatchCount: 0,
    quarantinedLineageMarkerCount: 0,
    scannedCount: 1,
    skippedCount: 0,
    unchangedCount: 1,
    updatedCount: 0,
  };
  const unboundDecision = await evaluateEventPublication(
    {
      db: {
        query(table) {
          assert.equal(table, "eventDomainMigrationState");
          const chain = {
            withIndex(_index, apply) {
              const builder = {
                eq() {
                  return builder;
                },
              };
              apply(builder);
              return chain;
            },
            async take() {
              return [completeBindingState];
            },
          };
          return chain;
        },
      },
    },
    {
      _id: "event-unbound-after-coverage",
      artists: [],
      date: "2026-09-07",
      eventType: "culture",
      status: "approved",
      title: "Unbound event",
      updatedAt: 1,
      venue: "Mutable legacy alias",
    },
  );
  assert.equal(
    unboundDecision.reason,
    "venue_unresolved",
    "Complete venue-binding coverage must keep a later unbound event out of materialized publication.",
  );
}

{
  const state = makeLegacyVenueRefreshContext();
  state.scheduled.push({
    cursor: null,
    phase: "venue_id",
    venueId: state.venue._id,
  });
  while (state.scheduled.length > 0) {
    const args = state.scheduled.shift();
    await refreshVenuePublicationPage._handler(state.ctx, args);
  }
  assert.equal(
    state.events.get("legacy-by-handle").publicationState,
    "pending_verification",
    "A hidden venue must invalidate a legacy handle/name-bound event before venueId migration.",
  );
  assert.equal(
    state.events.get("legacy-by-handle").publicationReason,
    "venue_unavailable",
  );
}

{
  const hiddenVenue = {
    _id: "hidden-live-venue",
    instagramHandle: "hidden_live",
    name: "Hidden Live Venue",
    publicStatus: "hidden",
    scrapeActive: true,
  };
  const baseEvent = {
    _id: "materialized-event",
    artists: [],
    date: "2026-09-06",
    eventType: "music",
    normalizedFieldsJson: "{}",
    publicationPolicyVersion: 1,
    publicationReason: "canonical_source_grounding_verified",
    publicationState: "publishable",
    status: "approved",
    title: "Materialized event",
    updatedAt: 1,
    venue: hiddenVenue.name,
  };
  const identity = {
    _id: "hidden-live-identity",
    active: false,
    kind: "canonical_name",
    normalizedValue: "hidden live venue",
    rawValue: hiddenVenue.name,
    venueId: hiddenVenue._id,
  };
  const publicVenue = {
    ...hiddenVenue,
    _id: "public-live-venue",
    name: "Public Live Venue",
    publicStatus: "published",
  };
  const makeVisibilityCtx = (identities) => ({
    db: {
      async get(id) {
        if (id === hiddenVenue._id) return hiddenVenue;
        if (id === publicVenue._id) return publicVenue;
        return null;
      },
      query(table) {
        const filters = {};
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
          async take(limit) {
            const rows = table === "venueIdentities" ? identities : [];
            return rows
              .filter((row) =>
                Object.entries(filters).every(([field, value]) => row[field] === value),
              )
              .slice(0, limit);
          },
        };
        return chain;
      },
    },
  });

  let rejectedRowReadCount = 0;
  const rejectedMaterializedContext = {
    db: {
      async get() {
        rejectedRowReadCount += 1;
        throw new Error("A materialized non-public row must not load related documents.");
      },
      query() {
        rejectedRowReadCount += 1;
        throw new Error("A materialized non-public row must not query related tables.");
      },
    },
  };
  assert.equal(
    await isEventPubliclyVisible(rejectedMaterializedContext, {
      ...baseEvent,
      publicationReason: "canonical_source_grounding_missing",
      publicationState: "pending_verification",
      venueId: hiddenVenue._id,
    }),
    false,
    "A current materialized non-public decision must reject before venue or provenance reads.",
  );
  assert.equal(
    rejectedRowReadCount,
    0,
    "Rejected materialized rows must consume zero related-document reads.",
  );

  assert.equal(
    await isEventPubliclyVisible(
      makeVisibilityCtx([]),
      { ...baseEvent, venueId: hiddenVenue._id },
    ),
    false,
    "A venueId-bound event must become invisible immediately, before its refresh job runs.",
  );
  assert.equal(
    await isEventPubliclyVisible(
      makeVisibilityCtx([identity]),
      {
        ...baseEvent,
        publicationPolicyVersion: undefined,
        publicationReason: undefined,
        publicationState: undefined,
      },
      { allowNeverMigratedApproved: true },
    ),
    true,
    "An inactive identity must not remain a publication authority for a legacy unbound event.",
  );
  assert.equal(
    await isEventPubliclyVisible(
      makeVisibilityCtx([
        identity,
        { ...identity, _id: "active-public", active: true, venueId: publicVenue._id },
      ]),
      {
        ...baseEvent,
        publicationPolicyVersion: undefined,
        publicationReason: undefined,
        publicationState: undefined,
      },
      { allowNeverMigratedApproved: true },
    ),
    true,
    "An inactive historical owner must not make one active public identity ambiguous.",
  );
}

{
  const originalNow = Date.now;
  const originalSecret = process.env.CRON_SECRET;
  Date.now = () => Date.parse("2026-11-09T12:00:00.000Z");
  process.env.CRON_SECRET = "qa-approved-publication-repair";
  const table = (rows) => new Map(rows.map((row) => [row._id, row]));
  const venue = { _id: "repair-venue", name: "QA Theater", instagramHandle: "qa_theater", category: "culture", publicStatus: "published", updatedAt: 1 };
  const expected = (key, date, title, day, artists = []) => {
    const sourceLine = `${day} November, 20:00: ${title}`;
    return {
      key, date, title, time: "20:00", venue: venue.name, artists,
      factsJson: JSON.stringify({
        localDate: date, titleClaim: title, eventTypeClaim: "arts & culture", artistClaims: artists, venueClaim: venue.name,
        startTime: "20:00", timeRelation: "exact", sourceRowIdentity: sourceLine, evidence: [],
        policy: { approvalDisposition: "approved", pendingReasons: [], signals: [], structuredEvidenceVerified: true },
      }),
      canonicalEventJson: JSON.stringify({
        dateEvidenceResolvedDate: date, normalizedFieldsJson: "{}", requestedStatus: "approved", sourceConflictFields: [],
        time: "20:00", timeConfidence: 1, timeSource: "caption", timeStatus: "confirmed",
      }),
    };
  };
  const expired = expected("expired", "2026-11-08", "Expired QA play", 8);
  const primary = expected("primary", "2026-11-10", "Upcoming QA play", 10);
  const missing = expected("missing", "2026-11-11", "Second QA play", 11);
  const donor = expected("donor", "2026-11-11", "Second QA play", 11, ["QA Performer"]);
  function makeSource(code, expectedRows, own, visible) {
    const caption = expectedRows.map((row) => JSON.parse(row.factsJson).sourceRowIdentity).join("\n");
    const sourceIdentity = `instagram-source-identity-v1:${code}`;
    const instagramPostUrl = `https://www.instagram.com/p/${code}/`;
    const sourceFingerprint = buildInstagramSourceOccurrenceFingerprint({ caption });
    const rawExtractionJson = JSON.stringify({
      extraction_contract_version: "event_evidence_v2", is_event: true,
      schedule_entries: expectedRows.map((row) => {
        const line = JSON.parse(row.factsJson).sourceRowIdentity;
        return { date: row.date, source_text: line, date_evidence: { resolved_date: row.date, source: "caption", exact_text: line.split(",")[0] },
          title: row.title, time: row.time, venue: row.venue, artists: row.artists };
      }),
    });
    const post = { _id: `post-${code}`, postId: `provider-${code}`, handle: "qa_theater", username: "qa_theater", caption,
      instagramPostUrl, sourceRevision: 1, analysisRevision: 1, analysisModel: "gpt-6-luna", analysisResultJson: rawExtractionJson,
      analysisIsEvent: true, analysisContractVersion: "event_evidence_v2", imageUrls: [], postedAt: "2026-11-05T12:00:00Z", updatedAt: 1 };
    const event = { _id: `event-${code}`, _creationTime: 1, status: "approved", updatedAt: 1, date: own.date, title: own.title,
      venue: venue.name, venueId: venue._id, venueInstagramHandle: venue.instagramHandle, eventType: "arts & culture", artists: own.artists,
      time: own.time, sourceConflictFields: [], sourceCaption: caption, sourcePostedAt: post.postedAt, instagramPostId: post.postId, instagramPostUrl,
      sourceOccurrenceKey: own.key, rawExtractionJson, reviewedAt: 1, reviewedBy: "qa-reviewer", moderationNote: "Verified exact saved source and title.",
      humanReviewedStructuredSourcePolicyVersion: 1, publicationPolicyVersion: 1, publicationState: visible ? "publishable" : "pending_verification",
      publicationReason: visible ? "canonical_source_grounding_verified" : "occurrence_incomplete",
      normalizedFieldsJson: JSON.stringify({ extractionMode: "caption", extractionContractVersion: "event_evidence_v2", extractionIsEvent: true,
        sourceGroundingVersion: 5, sourceGroundingEvidence: "persisted_openai_event_evidence_v2", normalizedIsValid: true, dateSuspiciousYear: false,
        title: own.title, time: own.time, artists: own.artists, normalizedDate: own.date, normalizedVenue: own.venue,
        sourceGroundingSourceCaption: caption, sourceGroundingInstagramPostId: post.postId, sourceGroundingInstagramPostUrl: instagramPostUrl,
        sourceGroundingInstagramHandle: post.handle, sourceOccurrenceKey: own.key, sourceOccurrenceSourceFingerprint: sourceFingerprint,
        humanReviewedStructuredSourcePolicyVersion: 1 }) };
    const receipt = { _id: `receipt-${code}`, sourceIdentity, sourceFingerprint, expectedKeys: expectedRows.map((row) => row.key),
      expectedOccurrences: expectedRows, satisfiedKeys: [own.key], satisfiedOccurrences: [{ key: own.key, eventId: event._id }],
      deferredChildCount: 0, deferredChildKeys: [], updatedAt: 1 };
    const occurrences = expectedRows.map((row, ordinal) => ({ _id: `occurrence-${row.key}`, provider: "instagram", canonicalSourceUrl: instagramPostUrl,
      sourceDocumentId: post._id, sourceIdentity, sourceFingerprint, sourceRevision: 1, sourceOccurrenceKey: row.key, occurrenceOrdinal: ordinal,
      factsJson: row.factsJson, canonicalEventJson: row.canonicalEventJson, venueId: venue._id, venueResolutionStatus: "resolved",
      state: row.key === own.key ? "satisfied" : "expected", ...(row.key === own.key ? { canonicalEventId: event._id } : {}), updatedAt: 1 }));
    const link = { _id: `link-${code}`, eventId: event._id, sourceIdentity, sourceFingerprint, sourceOccurrenceKey: own.key,
      sourceOccurrenceId: `occurrence-${own.key}`, instagramPostId: post.postId, instagramPostUrl, canonicalSourceUrl: instagramPostUrl, updatedAt: 1 };
    return { post, event, receipt, occurrences, link };
  }
  const a = makeSource("QaVenueList", [expired, primary, missing], primary, false);
  const b = makeSource("QaPerformerPlay", [donor], donor, true);
  const tables = {
    events: table([a.event, b.event]), venues: table([venue]), scrapedPosts: table([a.post, b.post]),
    instagramSourceOccurrenceReceipts: table([a.receipt, b.receipt]), instagramEventSources: table([a.link, b.link]),
    sourceOccurrences: table([...a.occurrences, ...b.occurrences]),
  };
  const getTable = (name) => tables[name] ??= new Map();
  const rowTable = (id) => Object.values(tables).find((rows) => rows.has(id));
  let inserted = 0;
  function query(name, filters = []) {
    const results = () => [...getTable(name).values()].filter((row) => filters.every(([field, value]) => row[field] === value));
    return {
      withIndex(_name, applyFilters) {
        const nextFilters = [...filters];
        const builder = { eq(field, value) { nextFilters.push([field, value]); return builder; } };
        applyFilters(builder);
        return query(name, nextFilters);
      },
      async take(limit) { return results().slice(0, limit); },
      async unique() { const matches = results(); assert.ok(matches.length <= 1); return matches[0] ?? null; },
    };
  }
  const ctx = { auth: { getUserIdentity: async () => null }, db: {
    query,
    async get(id) { return rowTable(id)?.get(id) ?? null; },
    async patch(id, patch) { const rows = rowTable(id); rows.set(id, { ...rows.get(id), ...patch }); },
    async insert(name, value) { const id = `qa-pub-insert-${++inserted}`; getTable(name).set(id, { ...value, _id: id }); return id; },
  } };
  try {
    const args = { id: a.event._id, serviceSecret: process.env.CRON_SECRET };
    await assert.rejects(() => preview._handler(ctx, { ...args, serviceSecret: "incorrect" }), /Authentication required/u);
    const proposed = await preview._handler(ctx, args);
    assert.deepEqual(proposed.missing.map((row) => [row.key, row.outcome, row.representativeId]),
      [[expired.key, "expired", null], [missing.key, "attach", b.event._id]]);
    assert.equal(proposed.ready, true);
    assert.equal(tables.events.get(a.event._id).publicationState, "pending_verification");
    const extra = { ...b.event, _id: "same-date-candidate" };
    tables.events.set(extra._id, extra);
    const ambiguous = await preview._handler(ctx, args);
    assert.equal(ambiguous.ready, false);
    assert.equal(ambiguous.missing[1].outcome, "missing_unique_approved_representative");
    tables.events.delete(extra._id);
    const applyArgs = { ...args, reviewDigest: proposed.reviewDigest, moderationNote: "Connect the missing reviewed repertory occurrence." };
    await ctx.db.patch(b.event._id, { updatedAt: 2 });
    await assert.rejects(() => apply._handler(ctx, applyArgs), /reviewed repair changed/u);
    const refreshed = await preview._handler(ctx, args);
    const result = await apply._handler(ctx, { ...applyArgs, reviewDigest: refreshed.reviewDigest });
    assert.deepEqual([result.attachedCount, result.expiredCount], [1, 1]);
    assert.equal(await isEventPubliclyVisible(ctx, tables.events.get(a.event._id)), true);
    assert.equal(await isEventPubliclyVisible(ctx, tables.events.get(b.event._id)), true);
    assert.equal(tables.sourceOccurrences.get(`occurrence-${expired.key}`).state, "superseded");
    assert.equal(tables.sourceOccurrences.get(`occurrence-${missing.key}`).canonicalEventId, b.event._id);
    assert.equal(tables.sourceOccurrences.get(`occurrence-${missing.key}`).factsJson, missing.factsJson);
    assert.equal(tables.events.size, 2);
  } finally {
    Date.now = originalNow;
    if (originalSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalSecret;
  }
}

console.log("Publication policy QA passed.");
