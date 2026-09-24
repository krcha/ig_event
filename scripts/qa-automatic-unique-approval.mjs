import assert from "node:assert/strict";

import { sweepPage } from "../convex/internal/automaticUniqueApproval.ts";
import {
  hasCompleteAutomaticUniqueSourceProof,
  hasExactSourceCollisionOrdinalProof,
} from "../convex/internal/automaticUniqueSourceProof.ts";
import {
  hasAutomaticUniqueStructuredSourceAttestation,
  hasHumanReviewableStructuredSourceAttestation,
  hasUnverifiedRepeatedTitleCaptionContradiction,
} from "../lib/events/event-update-precondition.ts";
import { isCanonicallyGroundedApprovedEvent } from "../convex/publicEventGrounding.ts";

const sourceUrl = "https://www.instagram.com/p/QAEXACT1/";
const event = {
  _id: "qa-auto-unique",
  _creationTime: 1,
  title: "QA Concert",
  date: "2035-01-15",
  time: "20:00",
  venue: "QA Hall",
  artists: ["QA Band"],
  sourceCaption: "QA Concert 15 January 2035 at QA Hall",
  instagramPostId: "QAEXACT1",
  instagramPostUrl: sourceUrl,
  sourceOccurrenceKey: "qa-child-1",
  sourceConflictFields: [],
  rawExtractionJson: JSON.stringify({
    extraction_contract_version: "event_evidence_v2",
    is_event: true,
    source_conflicts: [],
  }),
  automaticUniqueApprovalPolicyVersion: 1,
};
const fields = {
  extractionContractVersion: "event_evidence_v2",
  extractionIsEvent: true,
  extractionNonEventReason: "",
  sourceGroundingVersion: 5,
  sourceGroundingEvidence: "persisted_openai_event_evidence_v2",
  sourceGroundingInstagramHandle: "qa_hall",
  sourceGroundingInstagramPostId: event.instagramPostId,
  sourceGroundingInstagramPostUrl: sourceUrl,
  sourceGroundingSourceCaption: event.sourceCaption,
  sourceOccurrenceKey: "qa-child-1",
  sourceOccurrenceSourceFingerprint: "qa-fingerprint-1",
  title: event.title,
  normalizedDate: event.date,
  time: event.time,
  normalizedVenue: event.venue,
  artists: event.artists,
  normalizedIsValid: true,
  dateSuspiciousYear: false,
  sourceConflictFields: [],
  extractionSourceConflicts: [],
  extractionSourceConflictCount: 0,
  sourceConflictResolutionVersion: 1,
  materialSourceConflicts: [],
  materialSourceConflictCount: 0,
  benignSourceConflicts: [],
  benignSourceConflictCount: 0,
  sourceAccountRole: "venue",
  dateEvidenceVerified: false,
  identityEvidenceVerified: false,
  timeEvidenceVerified: false,
  confidence: 0.01,
  moderationConfidenceScore: 0.01,
  automaticUniqueApprovalPolicyVersion: 1,
  moderationAutoApproved: true,
  moderationAutoApproveRule: "server_verified_unique_v1",
  moderationPendingReasons: [],
};
const exactFields = JSON.stringify(fields);
assert.equal(
  hasHumanReviewableStructuredSourceAttestation(exactFields, event),
  true,
  "The complete v2 source shape must bind the final event fields.",
);
assert.equal(
  hasAutomaticUniqueStructuredSourceAttestation(exactFields, event),
  true,
  "Low confidence and noncritical verification flags do not veto exact unique proof.",
);
assert.equal(
  hasUnverifiedRepeatedTitleCaptionContradiction(
    "Ｉ Ｉ SINOVI",
    "20:00 I SINOVI — bioskop",
    false,
  ),
  true,
  "Unicode styling and punctuation must not hide the repeated-token source mismatch.",
);
for (const [title, caption, identityVerified] of [
  ["I I SINOVI", "20:00 I I SINOVI — bioskop", false],
  ["I I SINOVI", "20:00 SINOVI — bioskop", false],
  ["I SINOVI", "20:00 I SINOVI — bioskop", false],
  ["I I SINOVI", "20:00 I SINOVI — bioskop", true],
]) {
  assert.equal(
    hasUnverifiedRepeatedTitleCaptionContradiction(
      title,
      caption,
      identityVerified,
    ),
    false,
  );
}

const cinemaEvent = {
  ...event,
  title: "I I SINOVI",
  sourceCaption: "20:00 I SINOVI — bioskop",
};
const cinemaFields = JSON.stringify({
  ...fields,
  title: cinemaEvent.title,
  sourceGroundingSourceCaption: cinemaEvent.sourceCaption,
});
assert.equal(
  hasHumanReviewableStructuredSourceAttestation(cinemaFields, cinemaEvent),
  true,
  "A human can review the conflicting title against its source.",
);
assert.equal(
  hasAutomaticUniqueStructuredSourceAttestation(cinemaFields, cinemaEvent),
  false,
  "The repeated title absent from the caption cannot receive machine approval.",
);
const publicReadTables = [];
assert.equal(
  await isCanonicallyGroundedApprovedEvent({
    db: {
      query(table) {
        publicReadTables.push(table);
        return { withIndex() { return { async take() { return []; } }; } };
      },
    },
  }, {
    ...cinemaEvent,
    status: "approved",
    normalizedFieldsJson: cinemaFields,
  }),
  false,
  "An old machine approval with the contradicted title must disappear from public reads.",
);
assert.equal(publicReadTables.includes("scrapedPosts"), false);
assert.equal(event.humanReviewedStructuredSourcePolicyVersion, undefined);
assert.equal(fields.humanReviewedStructuredSourcePolicyVersion, undefined);
assert.equal(
  hasAutomaticUniqueStructuredSourceAttestation(exactFields, {
    ...event,
    automaticUniqueApprovalPolicyVersion: undefined,
  }),
  false,
  "The machine marker must be bound on both the event and normalized fields.",
);
assert.equal(
  hasAutomaticUniqueStructuredSourceAttestation(exactFields, {
    ...event,
    sourceConflictFields: ["date"],
  }),
  false,
  "A material source contradiction must never pass the machine policy.",
);
assert.equal(
  hasAutomaticUniqueStructuredSourceAttestation(exactFields, {
    ...event,
    rawExtractionJson: JSON.stringify({ is_event: false }),
  }),
  false,
  "A persisted non-event result must never pass the machine policy.",
);
assert.equal(
  await hasCompleteAutomaticUniqueSourceProof({
    db: {
      query() {
        return { withIndex() { return { async take() { return []; } }; } };
      },
    },
  }, { ...event, normalizedFieldsJson: exactFields }),
  false,
  "The policy marker cannot replace the current persisted source document.",
);

const collisionFields = {
  ...fields,
  sourceOccurrenceAmbiguousProvenance: true,
  sourceOccurrenceCollisionOrdinal: 1,
  splitEventIndex: 1,
  rowSourceText: "15.01.2035 QA Concert",
  automaticUniqueCollisionProofVersion: 1,
};
const collisionReceipt = {
  expectedOccurrences: [
    { key: "qa-child-1", title: event.title, date: event.date, time: event.time, venue: event.venue, artists: event.artists },
    { key: "qa-child-2", title: "QA Workshop", date: event.date, time: event.time, venue: event.venue, artists: [] },
  ],
  satisfiedOccurrences: [
    { key: "qa-child-1", eventId: event._id },
    { key: "qa-child-2", eventId: "qa-other-event" },
  ],
};
const collisionSource = JSON.stringify({
  schedule_entries: [
    { source_text: collisionFields.rowSourceText, title: event.title, date: "15.01.2035", time: event.time, venue: event.venue, artists: event.artists },
    { source_text: "15.01.2035 QA Workshop", title: "QA Workshop", date: "15.01.2035", time: event.time, venue: event.venue, artists: [] },
  ],
});
assert.equal(
  hasExactSourceCollisionOrdinalProof(event, collisionFields, collisionSource, collisionReceipt),
  true,
  "Distinct source rows and one-to-one receipt bindings discharge a coarse-key collision.",
);
assert.equal(
  hasAutomaticUniqueStructuredSourceAttestation(JSON.stringify(collisionFields), event),
  true,
);
assert.equal(
  hasAutomaticUniqueStructuredSourceAttestation(
    JSON.stringify({ ...collisionFields, automaticUniqueCollisionProofVersion: undefined }),
    event,
  ),
  false,
  "An ambiguous source needs the versioned machine exception.",
);
assert.equal(
  hasExactSourceCollisionOrdinalProof(event, collisionFields, collisionSource, {
    ...collisionReceipt,
    expectedOccurrences: [collisionReceipt.expectedOccurrences[0], {
      ...collisionReceipt.expectedOccurrences[1],
      title: event.title,
      artists: event.artists,
    }],
  }),
  false,
  "The exception cannot authorize duplicate semantic bindings.",
);
assert.equal(
  hasExactSourceCollisionOrdinalProof(event, collisionFields,
    collisionSource.replace(collisionFields.rowSourceText, "stale source row"),
    collisionReceipt,
  ),
  false,
  "The exception fails if the current analyzed source no longer has the exact row.",
);

function makeSweepContext() {
  const rows = new Map([
    ["pending-newer", {
      _id: "pending-newer", _creationTime: 2,
      date: "2020-01-01", status: "pending", updatedAt: 1,
    }],
    ["pending-older", {
      _id: "pending-older", _creationTime: 1,
      date: "2020-01-01", status: "pending", updatedAt: 1,
    }],
  ]);
  let state = null;
  let failVenueOnce = true;
  const reads = [];
  function query(table, criteria = {}) {
    const selected = () => {
      const all = table === "events" ? [...rows.values()]
        : table === "automaticUniqueApprovalState" && state ? [state]
        : [];
      return all.filter((row) => Object.entries(criteria).every(([key, value]) => row[key] === value));
    };
    return {
      withIndex(_index, configure) {
        const exact = {};
        const builder = { eq(key, value) { exact[key] = value; return this; } };
        configure(builder);
        return query(table, { ...criteria, ...exact });
      },
      order() { return this; },
      async take(limit) {
        if (table === "venues" && failVenueOnce) {
          failVenueOnce = false;
          throw new TypeError("Malformed venue directory fixture");
        }
        return selected().slice(0, limit);
      },
      async paginate({ cursor, numItems }) {
        assert.equal(table, "events");
        assert.equal(numItems, 1);
        const anchorTime = cursor === null ? Infinity : rows.get(cursor)?._creationTime;
        const page = selected()
          .filter((row) => row._creationTime < anchorTime)
          .sort((left, right) => right._creationTime - left._creationTime)
          .slice(0, numItems);
        reads.push(page[0]?._id ?? null);
        return {
          page,
          continueCursor: page[0]?._id ?? cursor,
          isDone: selected().filter((row) => row._creationTime < (page[0]?._creationTime ?? anchorTime)).length === 0,
          pageStatus: "Done",
        };
      },
    };
  }
  const ctx = {
    db: {
      async get(id) { return rows.get(id) ?? (id === state?._id ? state : null); },
      query,
      async patch(id, patch) {
        if (id === state?._id) state = { ...state, ...patch };
        else rows.set(id, { ...rows.get(id), ...patch });
      },
      async insert(table, value) {
        assert.equal(table, "automaticUniqueApprovalState");
        state = { _id: "qa-sweep-state", ...value };
        return state._id;
      },
    },
  };
  return { ctx, reads, rows, get state() { return state; } };
}

const sweep = makeSweepContext();
const originalWarn = console.warn;
console.warn = () => {};
try {
  const first = await sweepPage._handler(sweep.ctx, {});
  assert.equal(first.scannedCount, 1);
  assert.equal(first.approvedCount, 0);
  assert.equal(first.cycleComplete, false);
  assert.equal(sweep.state.classificationErrorCount, 1);
  assert.equal(sweep.state.cursor, "pending-newer");
  assert.equal(sweep.rows.get("pending-newer").status, "pending");

  // Simulate a concurrent status mutation between pages. The durable cursor
  // still advances to the next older pending row.
  sweep.rows.get("pending-newer").status = "approved";
  const second = await sweepPage._handler(sweep.ctx, {});
  assert.equal(second.scannedCount, 1);
  assert.equal(second.cycleComplete, true);
  assert.deepEqual(sweep.reads, ["pending-newer", "pending-older"]);
  assert.equal(sweep.state.cursor, null);
  assert.equal(sweep.state.completedCycles, 1);
  assert.equal(sweep.state.classificationErrorCount, 1);
  const cooldown = await sweepPage._handler(sweep.ctx, {});
  assert.equal(cooldown.scannedCount, 0);
  assert.equal(cooldown.cycleComplete, true);
  assert.deepEqual(sweep.reads, ["pending-newer", "pending-older"]);
} finally {
  console.warn = originalWarn;
}

console.log("QA passed: automatic unique approval binds v2 source fields, fails closed, and advances the durable pending cursor.");
