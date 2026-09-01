import assert from "node:assert/strict";

import {
  buildOccurrenceSignature,
  toOccurrenceCandidateIndexFields,
} from "../lib/domain/occurrences/signature.ts";
import { reconcileOccurrence } from "../lib/domain/reconciliation/engine.ts";
import { loadOccurrenceCandidates } from "../convex/repositories/occurrenceCandidates.ts";

const signature = buildOccurrenceSignature({
  artists: ["DJ Žika", "Guest"],
  eventType: "nightlife",
  localDate: "2026-08-29",
  time: "23:00 - 04:00",
  title: "Velika Žurka Night",
  venueId: "venue-kc-grad",
  venueInstagramHandle: "ignored_when_id_exists",
});
const equivalentSignature = buildOccurrenceSignature({
  artists: ["guest", "DJ Zika"],
  eventType: "nightlife",
  localDate: "2026-08-29",
  time: "23h–04h",
  title: "VELIKA ZURKA",
  venueId: "venue-kc-grad",
});
assert.equal(signature.signatureHash, equivalentSignature.signatureHash);
assert.equal(signature.venueIdentity, "id:venue-kc-grad");
assert.equal(signature.localDate, "2026-08-29");
assert.deepEqual(toOccurrenceCandidateIndexFields(signature), {
  occurrenceArtistFingerprint: signature.artistFingerprint,
  occurrenceDateKey: "2026-08-29",
  occurrenceEventType: "nightlife",
  occurrenceSignatureHash: signature.signatureHash,
  occurrenceSignatureVersion: 1,
  occurrenceTimeIdentity: signature.timeIdentity,
  occurrenceTitleFamily: signature.titleFamily,
  occurrenceVenueIdentity: "id:venue-kc-grad",
});

function occurrence(id, overrides = {}) {
  return {
    artists: ["Artist One"],
    canonicalSourceUrl: `https://www.instagram.com/p/${id}/`,
    date: "2026-08-29",
    eventId: `event-${id}`,
    id,
    normalizedVenueIdentity: "kc grad",
    sourceIdentity: `instagram:${id}`,
    sourceOccurrenceKey: `occurrence:${id}`,
    time: "20:00",
    title: "Artist One Live",
    updatedAt: 10,
    venue: "KC Grad",
    ...overrides,
  };
}

const exactIncoming = occurrence("incoming", {
  eventId: undefined,
  sourceIdentity: "instagram:post-a",
  sourceOccurrenceKey: "occurrence:row-1",
});
const exactCandidate = occurrence("candidate", {
  sourceIdentity: "instagram:post-a",
  sourceOccurrenceKey: "occurrence:row-1",
});
const exact = reconcileOccurrence({
  candidates: [exactCandidate],
  incoming: exactIncoming,
  intent: "ingest_occurrence",
});
assert.equal(exact.decision.relation, "exact_source_occurrence");
assert.equal(exact.plan.action, "attach");
assert.equal(exact.plan.canonicalEventId, exactCandidate.eventId);

const exactWithTruncatedSemanticCandidates = reconcileOccurrence({
  candidateSetTruncated: true,
  candidates: [exactCandidate],
  incoming: exactIncoming,
  intent: "ingest_occurrence",
});
assert.equal(
  exactWithTruncatedSemanticCandidates.decision.relation,
  "exact_source_occurrence",
  "A unique exact source-occurrence binding remains decisive even when the broader semantic candidate set is truncated.",
);
assert.equal(exactWithTruncatedSemanticCandidates.plan.action, "attach");

const truncatedWithoutExact = reconcileOccurrence({
  candidateSetTruncated: true,
  candidates: [occurrence("semantic-only")],
  incoming: occurrence("truncated-incoming", { eventId: undefined }),
  intent: "ingest_occurrence",
});
assert.equal(truncatedWithoutExact.decision.relation, "ambiguous");
assert.deepEqual(truncatedWithoutExact.decision.reasons, [
  "indexed_candidate_set_truncated",
]);

const crossPost = reconcileOccurrence({
  candidates: [occurrence("venue-post")],
  incoming: occurrence("promoter-post", { eventId: undefined }),
  intent: "ingest_occurrence",
});
assert.equal(crossPost.decision.relation, "cross_post");
assert.equal(crossPost.plan.action, "attach");

const reliableDifferentTime = reconcileOccurrence({
  candidates: [occurrence("earlier", { time: "20:00" })],
  incoming: occurrence("later", { eventId: undefined, time: "23:00" }),
  intent: "ingest_occurrence",
});
assert.equal(reliableDifferentTime.decision.relation, "independent");
assert.equal(reliableDifferentTime.plan.action, "create");

const ambiguousUnknownTime = reconcileOccurrence({
  candidates: [
    occurrence("unknown-existing", {
      normalizedVenueIdentity: null,
      time: null,
      venue: null,
    }),
  ],
  incoming: occurrence("unknown-incoming", {
    eventId: undefined,
    normalizedVenueIdentity: null,
    time: null,
    venue: null,
  }),
  intent: "ingest_occurrence",
});
assert.equal(ambiguousUnknownTime.decision.relation, "ambiguous");
assert.equal(ambiguousUnknownTime.plan.action, "manual_review");

const multipleMatches = reconcileOccurrence({
  candidates: [occurrence("candidate-a"), occurrence("candidate-b")],
  incoming: occurrence("incoming-multi", { eventId: undefined }),
  intent: "ingest_occurrence",
});
assert.equal(multipleMatches.decision.relation, "ambiguous");
assert.deepEqual(multipleMatches.decision.reasons, [
  "multiple_equally_supported_canonical_candidates",
]);
assert.equal(multipleMatches.plan.action, "manual_review");

const supportedPlusAmbiguous = reconcileOccurrence(
  {
    candidates: [occurrence("supported"), occurrence("uncertain")],
    incoming: occurrence("incoming-conflict", { eventId: undefined }),
    intent: "ingest_occurrence",
  },
  [
    {
      name: "fixture",
      evaluate(_context, candidate) {
        return {
          candidateEventId: candidate.eventId,
          candidateOccurrenceId: candidate.id,
          confidence: candidate.id === "supported" ? "proven" : "ambiguous",
          evidence: [],
          reasons: [candidate.id],
          relation: candidate.id === "supported" ? "same_occurrence" : "ambiguous",
          strategy: this.name,
        };
      },
    },
  ],
);
assert.equal(
  supportedPlusAmbiguous.plan.action,
  "manual_review",
  "A supported match plus another ambiguous candidate must fail closed.",
);

{
  const candidate = (id) => ({ _id: id });
  const rowsByIndex = {
    by_occurrenceSignatureHash: [candidate("exact-a"), candidate("exact-b")],
    by_occurrenceDateVenue: [candidate("exact-a"), candidate("exact-b")],
    by_occurrenceDateTitle: [
      candidate("exact-a"),
      candidate("exact-b"),
      candidate("title-only-conflict"),
    ],
  };
  const db = {
    query() {
      return {
        withIndex(indexName, configure) {
          const q = { eq() { return q; } };
          configure(q);
          return {
            async take(limit) {
              return rowsByIndex[indexName].slice(0, limit);
            },
          };
        },
      };
    },
  };
  const bounded = await loadOccurrenceCandidates(
    db,
    toOccurrenceCandidateIndexFields(signature),
    2,
  );
  assert.equal(
    bounded.truncated,
    true,
    "A full exact bucket must not hide a title-only candidate outside the returned slice.",
  );
  assert.equal(bounded.candidates.length, 2);
}

console.log("Occurrence signature and reconciliation QA passed.");
