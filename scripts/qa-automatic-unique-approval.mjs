import assert from "node:assert/strict";

import { sweepPage } from "../convex/internal/automaticUniqueApproval.ts";
import { evaluateAutomaticUniqueApproval } from "../convex/internal/automaticUniqueApprovalPreflight.ts";
import { diagnosePending } from "../convex/automaticApprovalDiagnostics.ts";
import {
  diagnoseCompleteAutomaticUniqueSourceProof,
  hasCompleteAutomaticUniqueSourceProof,
  hasExactSourceCollisionOrdinalProof,
} from "../convex/internal/automaticUniqueSourceProof.ts";
import {
  hasAutomaticUniqueStructuredSourceAttestation,
  hasHumanReviewableStructuredSourceAttestation,
  hasUnverifiedRepeatedTitleCaptionContradiction,
} from "../lib/events/event-update-precondition.ts";
import { isCanonicallyGroundedApprovedEvent } from "../convex/publicEventGrounding.ts";
import { adaptInstagramScrapedPostToSourceDocument } from "../lib/domain/source-documents.ts";
import { buildInstagramSourceOccurrenceFingerprint } from "../lib/domain/occurrences/source-fingerprint.ts";
import { isSupportedExtractionModel } from "../convex/internal/extractionModel.ts";
import { buildVenueIdentityClaims } from "../lib/domain/venues/venue-resolver.ts";
import { automaticUniqueSourceVenueClaims } from "../convex/internal/automaticUniqueVenueEvidence.ts";

const supportedExtractionModels = [
  "gpt-5-mini",
  "gpt-5-mini-2025-08-07",
  "gpt-6-luna",
  "gpt-6-luna-2026-10-01",
];
const unsupportedExtractionModels = [
  undefined, null, "", "gpt-4.1-mini", "gpt-6-sol",
  "gpt-5-mini-qa", "gpt-5-miniature", "gpt-6-luna-spoofed",
  "gpt-6-luna-2026-10-01-extra", "gpt-6-luna-2026-02-30",
  "gpt-6-luna-2026-13-01", "gpt-6-luna-2026-1-01",
  "gpt-6-luna\n", " gpt-6-luna", "GPT-6-LUNA",
];
for (const model of supportedExtractionModels) {
  assert.equal(isSupportedExtractionModel(model), true, model);
}
for (const model of unsupportedExtractionModels) {
  assert.equal(isSupportedExtractionModel(model), false, String(model));
}

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

const pastSourceLine = "14.01.2035 Expired Sibling at QA Hall";
const proofCaption = `${event.sourceCaption}\n${pastSourceLine}`;
const proofRaw = JSON.stringify({
  ...JSON.parse(event.rawExtractionJson),
  schedule_entries: [
    {
      date: "15.01.2035", time: event.time, venue: event.venue,
      title: event.title, artists: event.artists,
      source_text: event.sourceCaption,
      date_evidence: { resolved_date: event.date },
    },
    {
      date: "14.01.2035", time: "", venue: event.venue,
      title: "Expired Sibling", artists: [],
      source_text: pastSourceLine,
      date_evidence: { resolved_date: "2035-01-14" },
    },
  ],
});
const proofSource = {
  _id: "qa-source-1",
  handle: "qa_hall",
  username: "qa_hall",
  postId: event.instagramPostId,
  instagramPostUrl: sourceUrl,
  caption: proofCaption,
  postedAt: "2035-01-01T12:00:00.000Z",
  sourceRevision: 1,
  analysisRevision: 1,
  analysisContractVersion: "event_evidence_v2",
  analysisIsEvent: true,
  analysisModel: "gpt-5-mini-2025-08-07",
  analysisResultJson: proofRaw,
};
const proofFingerprint = buildInstagramSourceOccurrenceFingerprint(proofSource);
const proofSourceIdentity = adaptInstagramScrapedPostToSourceDocument(
  proofSource,
).sourceIdentity;
const proofFields = JSON.stringify({
  ...fields,
  sourceGroundingSourceCaption: proofCaption,
  sourceOccurrenceSourceFingerprint: proofFingerprint,
});
const proofEvent = {
  ...event,
  status: "approved",
  sourceCaption: proofCaption,
  sourcePostedAt: proofSource.postedAt,
  rawExtractionJson: proofRaw,
  normalizedFieldsJson: proofFields,
};
const ownExpected = {
  key: event.sourceOccurrenceKey,
  date: event.date,
  time: event.time,
  title: event.title,
  venue: event.venue,
  artists: event.artists,
};
const pastExpected = {
  ...ownExpected,
  key: "qa-expired-sibling",
  date: "2035-01-14",
  title: "Expired Sibling",
  time: "TBD",
  artists: [],
};
const proofLink = {
  _id: "qa-link-1",
  eventId: proofEvent._id,
  sourceIdentity: proofSourceIdentity,
  sourceFingerprint: proofFingerprint,
  sourceOccurrenceKey: event.sourceOccurrenceKey,
};
const basePartialReceipt = {
  _id: "qa-receipt-1",
  sourceIdentity: proofSourceIdentity,
  sourceFingerprint: proofFingerprint,
  expectedKeys: [ownExpected.key, pastExpected.key],
  expectedOccurrences: [ownExpected, pastExpected],
  satisfiedKeys: [ownExpected.key],
  satisfiedOccurrences: [{ key: ownExpected.key, eventId: proofEvent._id }],
  deferredChildCount: 0,
  deferredChildKeys: [],
  createdAt: 1,
  updatedAt: 1,
};
function proofContext(
  receipt = basePartialReceipt,
  source = proofSource,
  representative = proofEvent,
  directory = null,
  link = proofLink,
) {
  return {
    db: {
      async get(id) { return id === representative._id ? representative : directory?.venues.find((venue) => venue._id === id) ?? null; },
      query(table) {
        return {
          withIndex(indexName, configure) {
            const filters = {};
            const q = { eq(key, value) { filters[key] = value; return q; } };
            configure(q);
            const rows = table === "scrapedPosts" ? [source]
              : table === "instagramSourceOccurrenceReceipts" ? [receipt]
                : table === "instagramEventSources" ? [link]
                  : table === "eventDomainMigrationState" && directory ? [{ key: "venue-identities-v1", completedAt: 1, mismatchCount: 0 }]
                    : table === "venueIdentities" && directory ? directory.identities
                      : table === "instagramSources" && directory ? directory.sources ?? [] : [];
            return {
              async take(limit) {
                return rows.filter((row) =>
                  Object.entries(filters).every(([key, value]) => row[key] === value)
                ).slice(0, limit);
              },
            };
          },
        };
      },
    },
  };
}
const originalProofNow = Date.now;
try {
  Date.now = () => Date.parse("2035-01-15T00:00:00.000Z");
  for (const model of supportedExtractionModels) {
    const source = { ...proofSource, analysisModel: model };
    assert.equal(
      await hasCompleteAutomaticUniqueSourceProof(
        proofContext(basePartialReceipt, source), proofEvent,
      ),
      true,
      `${model} must preserve exact automatic approval evidence.`,
    );
    assert.equal(
      await isCanonicallyGroundedApprovedEvent(
        proofContext(basePartialReceipt, source), proofEvent,
      ),
      true,
      `${model} must preserve public grounding for exact unique proof.`,
    );
  }
  for (const model of unsupportedExtractionModels) {
    const source = { ...proofSource, analysisModel: model };
    assert.equal(
      await hasCompleteAutomaticUniqueSourceProof(
        proofContext(basePartialReceipt, source), proofEvent,
      ),
      false,
      `${String(model)} cannot establish automatic approval provenance.`,
    );
    assert.equal(
      await isCanonicallyGroundedApprovedEvent(
        proofContext(basePartialReceipt, source), proofEvent,
      ),
      false,
      `${String(model)} cannot establish public grounding provenance.`,
    );
  }
  for (const overrides of [
    { analysisRevision: 0 },
    { analysisIsEvent: false },
    { analysisResultJson: "stale analysis" },
  ]) {
    assert.equal(
      await hasCompleteAutomaticUniqueSourceProof(
        proofContext(basePartialReceipt, {
          ...proofSource, analysisModel: "gpt-6-luna", ...overrides,
        }),
        proofEvent,
      ),
      false,
      "Luna evidence must retain current revision, event, and exact-result checks.",
    );
  }
  assert.equal(
    await hasCompleteAutomaticUniqueSourceProof(proofContext(), proofEvent),
    true,
    "At 01:00 in Belgrade yesterday's missing sibling may be skipped for a later-date event.",
  );
  const sameDayRaw = JSON.stringify({
    ...JSON.parse(proofRaw),
    schedule_entries: [
      {
        ...JSON.parse(proofRaw).schedule_entries[0],
        date: "14.01.2035",
        date_evidence: { resolved_date: "2035-01-14" },
      },
      JSON.parse(proofRaw).schedule_entries[1],
    ],
  });
  const sameDaySource = { ...proofSource, analysisResultJson: sameDayRaw };
  const sameDayEvent = {
    ...proofEvent,
    date: "2035-01-14",
    rawExtractionJson: sameDayRaw,
    normalizedFieldsJson: JSON.stringify({
      ...JSON.parse(proofFields),
      normalizedDate: "2035-01-14",
    }),
  };
  const sameDayReceipt = {
    ...basePartialReceipt,
    expectedOccurrences: [{ ...ownExpected, date: "2035-01-14" }, pastExpected],
  };
  assert.equal(
    await hasCompleteAutomaticUniqueSourceProof(
      proofContext(sameDayReceipt, sameDaySource, sameDayEvent),
      sameDayEvent,
    ),
    false,
    "An already-approved event cannot skip an unsatisfied sibling on its own date overnight.",
  );
  assert.equal(
    await isCanonicallyGroundedApprovedEvent(
      proofContext(sameDayReceipt, sameDaySource, sameDayEvent),
      sameDayEvent,
    ),
    false,
  );
  Date.now = () => Date.parse("2035-01-15T12:00:00.000Z");
  assert.equal(
    await hasCompleteAutomaticUniqueSourceProof(proofContext(), proofEvent),
    true,
    "Only an exact past-dated unsatisfied sibling may be omitted from a current source receipt.",
  );
  assert.equal(
    await isCanonicallyGroundedApprovedEvent(proofContext(), proofEvent),
    true,
    "Public grounding must accept the same bounded past-sibling proof.",
  );
  for (const missingDate of ["2035-01-15", "2035-01-16", "2035-02-30", "bad-date"]) {
    const receipt = {
      ...basePartialReceipt,
      expectedOccurrences: [ownExpected, { ...pastExpected, date: missingDate }],
    };
    assert.equal(
      await hasCompleteAutomaticUniqueSourceProof(proofContext(receipt), proofEvent),
      false,
      `An unsatisfied ${missingDate} sibling must block machine approval.`,
    );
    assert.equal(await isCanonicallyGroundedApprovedEvent(proofContext(receipt), proofEvent), false);
  }
  const malformedReceipts = [
    { ...basePartialReceipt, expectedKeys: [ownExpected.key, pastExpected.key, pastExpected.key] },
    { ...basePartialReceipt, satisfiedKeys: [ownExpected.key, ownExpected.key] },
    { ...basePartialReceipt, satisfiedOccurrences: [
      ...basePartialReceipt.satisfiedOccurrences,
      basePartialReceipt.satisfiedOccurrences[0],
    ] },
  ];
  for (const receipt of malformedReceipts) {
    assert.equal(await hasCompleteAutomaticUniqueSourceProof(proofContext(receipt), proofEvent), false);
  }
  assert.equal(
    await hasCompleteAutomaticUniqueSourceProof(proofContext(), {
      ...proofEvent,
      normalizedFieldsJson: JSON.stringify({
        ...JSON.parse(proofFields),
        sourceOccurrenceAmbiguousProvenance: true,
      }),
    }),
    false,
    "Collision-ambiguous provenance still requires a fully satisfied receipt.",
  );
  assert.equal(
    await hasCompleteAutomaticUniqueSourceProof(proofContext(basePartialReceipt, {
      ...proofSource,
      analysisResultJson: "stale analysis",
    }), proofEvent),
    false,
    "Expiry does not relax the exact current source revision check.",
  );
  const futureRaw = JSON.stringify({
    ...JSON.parse(proofRaw),
    schedule_entries: [
      JSON.parse(proofRaw).schedule_entries[0],
      {
        ...JSON.parse(proofRaw).schedule_entries[1],
        date: "16.01.2035",
        date_evidence: { resolved_date: "2035-01-16" },
      },
    ],
  });
  const futureSource = { ...proofSource, analysisResultJson: futureRaw };
  const futureEvent = { ...proofEvent, rawExtractionJson: futureRaw };
  assert.equal(
    buildInstagramSourceOccurrenceFingerprint(futureSource),
    proofFingerprint,
    "A reanalysis can change raw schedule dates without changing the caption fingerprint.",
  );
  assert.equal(
    await hasCompleteAutomaticUniqueSourceProof(
      proofContext(basePartialReceipt, futureSource),
      futureEvent,
    ),
    false,
    "An old past receipt date cannot override a current future source schedule row.",
  );
  assert.equal(
    await isCanonicallyGroundedApprovedEvent(
      proofContext(basePartialReceipt, futureSource),
      futureEvent,
    ),
    false,
  );
} finally {
  Date.now = originalProofNow;
}

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
  const holds = new Map();
  let state = null;
  let failVenueOnce = true;
  const reads = [];
  function query(table, criteria = {}) {
    const selected = () => {
      const all = table === "events" ? [...rows.values()]
        : table === "automaticApprovalHolds" ? [...holds.values()]
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
      async get(id) { return rows.get(id) ?? holds.get(id) ?? (id === state?._id ? state : null); },
      query,
      async patch(id, patch) {
        if (holds.has(id)) holds.set(id, { ...holds.get(id), ...patch });
        else if (id === state?._id) state = { ...state, ...patch };
        else rows.set(id, { ...rows.get(id), ...patch });
      },
      async insert(table, value) {
        if (table === "automaticApprovalHolds") {
          const id = "qa-hold-" + (holds.size + 1);
          holds.set(id, { _id: id, ...value });
          return id;
        }
        assert.equal(table, "automaticUniqueApprovalState");
        state = { _id: "qa-sweep-state", ...value };
        return state._id;
      },
    },
  };
  return { ctx, reads, rows, holds, get state() { return state; } };
}

const sweep = makeSweepContext();
const originalWarn = console.warn;
const originalInfo = console.info;
console.warn = () => {};
console.info = () => {};
try {
  const first = await sweepPage._handler(sweep.ctx, {});
  assert.equal(first.scannedCount, 1);
  assert.equal(first.approvedCount, 0);
  assert.equal(first.cycleComplete, false);
  assert.equal(sweep.state.classificationErrorCount, 1);
  assert.equal(sweep.state.cursor, "pending-newer");
  assert.equal(sweep.rows.get("pending-newer").status, "pending");
  assert.equal(sweep.rows.get("pending-newer").updatedAt, 1);
  assert.equal(sweep.holds.get("qa-hold-1").holdReason, "evaluation_error");

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
  console.info = originalInfo;
}

const proofAsOfMs = Date.parse("2035-01-15T12:00:00.000Z");
const sourceDiagnostic = await diagnoseCompleteAutomaticUniqueSourceProof(proofContext(), proofEvent, proofAsOfMs);
assert.equal(sourceDiagnostic.reason, "complete");
assert.equal(sourceDiagnostic.sourcePostId, proofSource._id);
assert.equal(sourceDiagnostic.sourceRevision, 1);
assert.deepEqual(sourceDiagnostic.missingOccurrenceKeys, [pastExpected.key]);
for (const [override, reason] of [
  [{ analysisRevision: 0 }, "source_analysis_stale"],
  [{ analysisIsEvent: false }, "source_analysis_non_event"],
  [{ analysisModel: "gpt-6-sol" }, "source_analysis_model_unsupported"],
  [{ analysisResultJson: "stale analysis" }, "source_analysis_binding_mismatch"],
]) {
  const diagnostic = await diagnoseCompleteAutomaticUniqueSourceProof(proofContext(basePartialReceipt, { ...proofSource, ...override }), proofEvent, proofAsOfMs);
  assert.equal(diagnostic.complete, false);
  assert.equal(diagnostic.reason, reason);
  assert.equal(diagnostic.sourcePostId, proofSource._id);
}
const pendingProofEvent = { ...proofEvent, status: "pending", updatedAt: 10 };
const exactReview = {
  result: { complete: true, items: [{ id: pendingProofEvent._id, expectedUpdatedAt: 10, disposition: "unique", reason: "unique_no_conflict", conflictIds: [] }] },
  reviewedEvents: new Map([[pendingProofEvent._id, pendingProofEvent]]),
  approvals: new Map([[pendingProofEvent._id, { prepared: { candidate: pendingProofEvent, venuePatch: {} }, humanReviewPatch: {} }]]),
};
const readyPreflight = await evaluateAutomaticUniqueApproval(proofContext(basePartialReceipt, proofSource, pendingProofEvent), pendingProofEvent, { asOfMs: proofAsOfMs, prebuiltReview: exactReview });
assert.equal(readyPreflight.diagnostic.eligible, true);
assert.equal(readyPreflight.diagnostic.holdReason, "eligible");
assert.equal(readyPreflight.diagnostic.repairCategory, "none");
assert.ok(readyPreflight.approval);
assert.equal(pendingProofEvent.status, "pending");
assert.equal(pendingProofEvent.updatedAt, 10);

// This exact historical label error escaped the queue after its real peer
// was repaired: the mutable Dolly label still matched itself, while every
// immutable source venue claim named the distinct Sava Centar concert hall.
const concertHall = { _id: "sava-centar", name: "Sava Centar", instagramHandle: "sava.centar", publicStatus: "published", category: "venue" };
const restaurant = { _id: "dolly-bell", name: "Dolly Bell Sava Centar", instagramHandle: "dolly.bell.sc", publicStatus: "published", category: "venue" };
const directory = { venues: [concertHall, restaurant], identities: [concertHall, restaurant].flatMap((venue) =>
  buildVenueIdentityClaims(venue).map((claim, index) => ({ ...claim, _id: `${venue._id}-${index}`, venueId: venue._id, active: true }))),
  sources: [{ handle: "the.clubber", role: "promoter", active: false }] };
async function venuePreflight(claim, venue, { title = "VELIKI SOLISTIČKI KONCERT MIRE ŠKORIĆ POVODOM 40 GODINA KARIJERE", handle = "tickets.rs", artists = ["MIRA Škorić"], date = "2026-11-19", extraRows = [], globalClaim = claim } = {}) {
  const sourceRow = `${title} ${date}`;
  const raw = JSON.stringify({ ...JSON.parse(event.rawExtractionJson), venue: globalClaim,
    schedule_entries: [{ date, venue: claim, title, artists, source_text: sourceRow,
      date_evidence: { resolved_date: date } }, ...extraRows] });
  const saved = { ...proofSource, handle, username: handle, analysisResultJson: raw,
    caption: `${title} ${date} ${claim}`, postedAt: "2026-10-01T12:00:00.000Z" };
  const fingerprint = buildInstagramSourceOccurrenceFingerprint(saved);
  const candidate = { ...pendingProofEvent, title, date, venue: venue.name, venueId: venue._id,
    venueInstagramHandle: venue.instagramHandle, artists, rawExtractionJson: raw,
    sourceCaption: saved.caption, sourcePostedAt: saved.postedAt,
    normalizedFieldsJson: JSON.stringify({ ...fields, title, normalizedDate: date, normalizedVenue: venue.name,
      rawVenue: claim, rowSourceText: sourceRow, artists, sourceGroundingInstagramHandle: handle,
      sourceGroundingSourceCaption: saved.caption, sourceOccurrenceSourceFingerprint: fingerprint }) };
  const expected = { ...ownExpected, date, title, venue: venue.name, artists: candidate.artists };
  const receipt = { ...basePartialReceipt, sourceFingerprint: fingerprint, expectedKeys: [expected.key],
    expectedOccurrences: [expected], satisfiedKeys: [expected.key] };
  const ctx = proofContext(receipt, saved, candidate, directory, { ...proofLink, sourceFingerprint: fingerprint });
  const review = { ...exactReview, approvals: new Map([[candidate._id, { prepared: { candidate, venuePatch: {} }, humanReviewPatch: {} }]]) };
  const asOfMs = Date.parse("2026-10-15T12:00:00.000Z");
  const originalNow = Date.now;
  try {
    // Source-attestation expiry checks must use the same scenario clock as preflight.
    Date.now = () => asOfMs;
    return await evaluateAutomaticUniqueApproval(ctx, candidate, { asOfMs, prebuiltReview: review });
  } finally {
    Date.now = originalNow;
  }
}
const staleDollyConcert = await venuePreflight("Sava Centar", restaurant);
assert.equal(staleDollyConcert.diagnostic.holdReason, "persisted_source_policy_failed");
assert.equal(staleDollyConcert.diagnostic.repairCategory, "none", "a cross-brand venue replacement is not an autonomous alias repair");
assert.equal(staleDollyConcert.approval, null);
assert.equal((await venuePreflight("Sava Centar", concertHall)).diagnostic.eligible, true);
for (const [title, artists, date] of [["Marija Mihajlov, Hedonija Music", ["Marija Mihajlov", "Hedonija Music"], "2026-10-24"], ["Dejan Vrana", ["Dejan Vrana"], "2026-10-23"]]) {
  assert.equal((await venuePreflight("Dolly Bell Sava Centar", restaurant, { title, artists, date, handle: "dolly.bell.sc" })).diagnostic.eligible, true,
    "an explicit Dolly restaurant show remains eligible under the same source proof");
}
assert.equal((await venuePreflight("Dolly Bell Sava Centar", restaurant, { handle: "other.promoter" })).diagnostic.eligible, true,
  "posting provider identity does not override an independently named physical venue");
assert.equal((await venuePreflight("", restaurant, { globalClaim: "" })).diagnostic.eligible, true,
  "an absent venue claim does not create a new approval requirement");
assert.equal((await venuePreflight("Unknown cellar", restaurant)).diagnostic.eligible, true,
  "an unresolved claim retains the existing source policy");
assert.equal((await venuePreflight("the.clubber", restaurant)).diagnostic.holdReason, "persisted_source_policy_failed",
  "an explicitly excluded provider identity is not treated as an unknown physical venue, including a paused source");
assert.equal((await venuePreflight("Dolly Bell Sava Centar", restaurant, { globalClaim: "Sava Centar",
  extraRows: [{ source_text: "Another day in Sava Centar", venue: "Sava Centar" }] })).diagnostic.eligible, true,
  "an exact selected-row venue outranks a different global parent or another day's venue");
assert.deepEqual(automaticUniqueSourceVenueClaims({ rawVenue: "Sava Centar", rowSourceText: "Friday restaurant show" }, {
  extraction_contract_version: "event_evidence_v2", is_event: true, venue: "Sava Centar", schedule_entries: [
    { source_text: "Friday restaurant show", venue: "Dolly Bell Sava Centar" },
    { source_text: "Saturday hall concert", venue: "Sava Centar" },
  ],
}), ["Dolly Bell Sava Centar"]);
const reviewedPreflight = await evaluateAutomaticUniqueApproval({}, { ...pendingProofEvent, reviewedAt: 1 }, { asOfMs: proofAsOfMs });
assert.equal(reviewedPreflight.diagnostic.holdReason, "human_reviewed");
assert.equal(reviewedPreflight.approval, null);
const conflictReview = { ...exactReview, result: { complete: true, items: [{ ...exactReview.result.items[0], disposition: "ineligible", reason: "ineligible_source_conflict" }] }, approvals: new Map() };
const conflictPreflight = await evaluateAutomaticUniqueApproval(proofContext(basePartialReceipt, proofSource, pendingProofEvent), pendingProofEvent, { asOfMs: proofAsOfMs, prebuiltReview: conflictReview });
assert.equal(conflictPreflight.diagnostic.holdReason, "ineligible_source_conflict");
assert.equal(conflictPreflight.diagnostic.repairCategory, "source_conflict_review");
assert.equal(conflictPreflight.diagnostic.sourcePostId, proofSource._id);
assert.equal(conflictPreflight.approval, null);
const incompletePreflight = await evaluateAutomaticUniqueApproval(proofContext({ ...basePartialReceipt, deferredChildCount: 1, deferredChildKeys: ["qa-deferred"] }, proofSource, pendingProofEvent), pendingProofEvent, { asOfMs: proofAsOfMs, prebuiltReview: exactReview });
assert.equal(incompletePreflight.diagnostic.holdReason, "source_proof_incomplete");
assert.equal(incompletePreflight.diagnostic.repairCategory, "occurrence_completion");
assert.equal(incompletePreflight.approval, null);

process.env.ADMIN_CLERK_USER_IDS = "qa-diagnostic-owner";
process.env.CRON_SECRET = "qa-diagnostic-secret";
const diagnosticEvent = { _id: "qa-exact-diagnostic", _creationTime: 1, status: "pending", date: "2020-01-01", updatedAt: 123 };
let diagnosticReads = 0;
let diagnosticWrites = 0;
function diagnosticQuery(table, criteria = {}) {
  return {
    withIndex(_name, configure) { const filters = {}; const q = { eq(key, value) { filters[key] = value; return q; } }; configure(q); return diagnosticQuery(table, { ...criteria, ...filters }); },
    order() { return this; },
    async take(limit) { diagnosticReads += 1; const rows = table === "events" ? [diagnosticEvent] : []; return rows.filter((row) => Object.entries(criteria).every(([key, value]) => row[key] === value)).slice(0, limit); },
  };
}
const diagnosticCtx = {
  auth: { async getUserIdentity() { return { subject: "qa-diagnostic-owner" }; } },
  db: {
    async get(id) { diagnosticReads += 1; return id === diagnosticEvent._id ? diagnosticEvent : null; }, query: diagnosticQuery,
    async patch() { diagnosticWrites += 1; throw new Error("Read-only diagnostics wrote a row."); },
    async insert() { diagnosticWrites += 1; throw new Error("Read-only diagnostics inserted a row."); },
  },
};
const exactDiagnosticArgs = { items: [{ id: diagnosticEvent._id, expectedUpdatedAt: 123 }], asOfMs: proofAsOfMs };
const exactPendingDiagnostic = await diagnosePending._handler(diagnosticCtx, exactDiagnosticArgs);
assert.equal(exactPendingDiagnostic.items[0].holdReason, "ineligible_expired_event");
assert.equal(exactPendingDiagnostic.items[0].eligible, false);
assert.equal(diagnosticWrites, 0);
assert.equal(diagnosticEvent.updatedAt, 123);
const servicePendingDiagnostic = await diagnosePending._handler({ ...diagnosticCtx, auth: { async getUserIdentity() { return null; } } }, { ...exactDiagnosticArgs, serviceSecret: "qa-diagnostic-secret" });
assert.deepEqual(servicePendingDiagnostic, exactPendingDiagnostic);
const readsBeforeUnauthorized = diagnosticReads;
await assert.rejects(() => diagnosePending._handler({ ...diagnosticCtx, auth: { async getUserIdentity() { return null; } } }, exactDiagnosticArgs), /Authentication required/);
await assert.rejects(() => diagnosePending._handler({ ...diagnosticCtx, auth: { async getUserIdentity() { return { subject: "qa-not-admin" }; } } }, exactDiagnosticArgs), /Admin access required/);
assert.equal(diagnosticReads, readsBeforeUnauthorized);
await assert.rejects(() => diagnosePending._handler(diagnosticCtx, { ...exactDiagnosticArgs, items: [{ id: diagnosticEvent._id, expectedUpdatedAt: 122 }] }), /Event changed since/);
await assert.rejects(() => diagnosePending._handler(diagnosticCtx, { ...exactDiagnosticArgs, items: [exactDiagnosticArgs.items[0], exactDiagnosticArgs.items[0]] }), /unique exact/);
await assert.rejects(() => diagnosePending._handler(diagnosticCtx, { ...exactDiagnosticArgs, asOfMs: NaN }), /clock/);
assert.equal(diagnosticWrites, 0);

function makeHappySweepContext() {
  const pending = { ...proofEvent, status: "pending", updatedAt: 10, normalizedVenueIdentity: "qa hall" };
  const tables = new Map([
    ["events", new Map([[pending._id, structuredClone(pending)]])],
    ["scrapedPosts", new Map([[proofSource._id, structuredClone(proofSource)]])],
    ["instagramEventSources", new Map([[proofLink._id, structuredClone(proofLink)]])],
    ["instagramSourceOccurrenceReceipts", new Map([[basePartialReceipt._id, structuredClone(basePartialReceipt)]])],
  ]);
  const writes = [];
  const getTable = (name) => { if (!tables.has(name)) tables.set(name, new Map()); return tables.get(name); };
  function query(table, criteria = {}) {
    const selected = () => [...getTable(table).values()].filter((row) => Object.entries(criteria).every(([key, value]) => row[key] === value));
    return {
      withIndex(_index, configure) { const filters = {}; const q = { eq(field, value) { filters[field] = value; return q; } }; configure(q); return query(table, { ...criteria, ...filters }); },
      order() { return this; },
      async take(limit) { return selected().slice(0, limit); },
      async paginate({ cursor, numItems }) { assert.equal(cursor, null); assert.equal(numItems, 1); return { page: selected().slice(0, numItems), isDone: true, continueCursor: "", pageStatus: "Done" }; },
    };
  }
  const ctx = { db: {
    query,
    async get(id) { for (const rows of tables.values()) if (rows.has(id)) return rows.get(id); return null; },
    async patch(id, patch) { for (const [table, rows] of tables) if (rows.has(id)) { rows.set(id, { ...rows.get(id), ...structuredClone(patch) }); writes.push({ table, id, patch: structuredClone(patch) }); return; } throw new Error("Unexpected QA patch: " + id); },
    async insert(table, value) { const id = "qa-happy-" + table + "-" + (getTable(table).size + 1); getTable(table).set(id, { _id: id, _creationTime: Date.now(), ...structuredClone(value) }); writes.push({ table, id, insert: structuredClone(value) }); return id; },
  } };
  return { ctx, tables, writes, eventId: pending._id };
}
const happySweep = makeHappySweepContext();
const originalHappyNow = Date.now;
try {
  Date.now = () => proofAsOfMs;
  const observedBeforeApproval = await diagnosePending._handler(happySweep.ctx, { items: [{ id: happySweep.eventId, expectedUpdatedAt: 10 }], asOfMs: proofAsOfMs, serviceSecret: "qa-diagnostic-secret" });
  assert.equal(observedBeforeApproval.items[0].eligible, true);
  assert.equal(observedBeforeApproval.items[0].sourceProofReason, "complete");
  assert.equal(happySweep.writes.length, 0);
  const result = await sweepPage._handler(happySweep.ctx, {});
  assert.equal(result.approvedCount, 1);
  assert.equal(result.scannedCount, 1);
  assert.equal(result.cycleComplete, true);
  const approvedEvent = happySweep.tables.get("events").get(happySweep.eventId);
  assert.equal(approvedEvent.status, "approved");
  assert.equal(approvedEvent.automaticUniqueApprovalPolicyVersion, 1);
  assert.ok(approvedEvent.updatedAt > 10);
  assert.equal(approvedEvent.reviewedAt, undefined);
  assert.equal(approvedEvent.reviewedBy, undefined);
  assert.equal(approvedEvent.humanReviewedStructuredSourcePolicyVersion, undefined);
  assert.equal(approvedEvent.publicationState, "publishable");
  assert.equal(await isCanonicallyGroundedApprovedEvent(happySweep.ctx, approvedEvent), true);
  const finalFields = JSON.parse(approvedEvent.normalizedFieldsJson);
  assert.equal(finalFields.confidence, 0.01);
  assert.deepEqual(finalFields.moderationPendingReasons, []);
  assert.equal(happySweep.tables.get("eventAuditLog").size, 1);
  assert.equal(happySweep.tables.get("automaticUniqueApprovalState").values().next().value.approvedCount, 1);
  assert.equal(happySweep.tables.get("automaticApprovalHolds")?.size ?? 0, 0);
  assert.equal(happySweep.writes.some((write) => ["scrapedPosts", "instagramEventSources", "instagramSourceOccurrenceReceipts"].includes(write.table)), false);
} finally { Date.now = originalHappyNow; }

console.log("QA passed: automatic unique approval diagnostics are read-only, authenticated, exact-versioned, source-grounded, and match the approval sweep.");
