import assert from "node:assert/strict";

import { evaluatePublicationEligibility } from "../lib/domain/publication/policy.ts";
import {
  evaluateEventPublication,
  isEventPubliclyVisible,
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
      return events.get(id) ?? sourceOccurrences.get(id) ?? null;
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
  return { db, events, sourceOccurrences };
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
        async paginate() {
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

console.log("Publication policy QA passed.");
