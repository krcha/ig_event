import assert from "node:assert/strict";

import {
  buildOccurrenceSignature,
  toOccurrenceCandidateIndexFields,
} from "../lib/domain/occurrences/signature.ts";
import { reconcileOccurrence } from "../lib/domain/reconciliation/engine.ts";
import { loadOccurrenceCandidates } from "../convex/repositories/occurrenceCandidates.ts";
import { classifyExistingApprovedOccurrenceForTesting } from "../lib/pipeline/ingestion/post-processing-policy.ts";

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

const kcGradVenueId = "k174v2774mz14ercz82srjsxn98963p8";
const galleryVenueId = "k178952dxvmp76gqyfa7ps65mh896a43";
function exhibition(id, { title, venueId, venue, time = "20:00", exactDate = true, fields = {} }) {
  const date = "2026-11-09";
  return occurrence(id, {
    artists: [], date, eventType: "arts & culture", status: "approved", time, title, venue, venueId,
    instagramPostId: id, instagramPostUrl: `https://www.instagram.com/p/${id}/`,
    normalizedFieldsJson: JSON.stringify({
      title, normalizedDate: date, normalizedVenue: venue, artists: [], time,
      dateEvidenceVerified: exactDate,
      timeEvidenceKind: "start_time_stated", timeEvidenceVerified: true, timeStatus: "confirmed",
      ...(exactDate ? {} : { rowSourceText: `MON 9 Opening of the exhibition ${title} by the artist 20:00` }),
      ...fields,
    }),
  });
}
const schedule = exhibition("calendar-post", {
  title: "Earthworks", venue: "KC Grad", venueId: kcGradVenueId, exactDate: false,
});
const poster = exhibition("gallery-post", {
  title: "EARTH WORKS", venue: "Gradska Galerija", venueId: galleryVenueId,
});
const scheduleSignature = buildOccurrenceSignature({ ...schedule, localDate: schedule.date });
const posterSignature = buildOccurrenceSignature({ ...poster, localDate: poster.date });
assert.equal(scheduleSignature.titleFamily, posterSignature.titleFamily, "The date/title index must find the overlap across the two venue IDs.");
assert.notEqual(scheduleSignature.venueIdentity, posterSignature.venueIdentity);
function reconcileExhibition(incoming) {
  return reconcileOccurrence({ candidates: [schedule], incoming: { ...incoming, eventId: undefined }, intent: "ingest_occurrence" });
}
assert.equal(reconcileExhibition(poster).plan.action, "manual_review", "A gallery/host overlap retains distinct source bindings and cannot publish twice.");
assert.equal(classifyExistingApprovedOccurrenceForTesting(schedule, poster, poster.venueId), "ambiguous", "Legacy ingestion must hold a confirmed co-located overlap for review.");
const sameVenuePoster = exhibition("same-venue-post", {
  title: "EARTH WORKS", venue: "KC Grad", venueId: kcGradVenueId,
});
assert.equal(reconcileExhibition(sameVenuePoster).plan.action, "attach", "A distinctive title spacing variant and same confirmed slot share one canonical venue event.");
assert.equal(classifyExistingApprovedOccurrenceForTesting(schedule, sameVenuePoster, sameVenuePoster.venueId), "proven_duplicate");
assert.equal(reconcileExhibition({ ...sameVenuePoster, sourceIdentity: schedule.sourceIdentity }).plan.action, "create", "Different source occurrence keys in one source are independent.");
for (const [title, venueId, time, fields] of [
  ["EARTH WORKS", galleryVenueId, "21:00", {}],
  ["EARTH WORKS", galleryVenueId, "20:00", { timeEvidenceKind: "doors_open_only" }],
  ["EARTH WORKS", galleryVenueId, "20:00", { timeEvidenceVerified: false }],
  ["EARTH WORKS", galleryVenueId, "20:00", { normalizedDate: "2026-11-10" }],
  ["EARTH WORKS", "other-venue", "20:00", {}],
  ["EARTHWORKS II", galleryVenueId, "20:00", {}],
]) {
  assert.equal(reconcileExhibition(exhibition("different-post", {
    title, venue: "Gradska Galerija", venueId, time, fields,
  })).plan.action, "create", "A different title, time, venue or unconfirmed start cannot establish the gallery/host overlap.");
}

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
