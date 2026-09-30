import assert from "node:assert/strict";

import { sourceBoundEmptyV2VenueClaimsForTesting } from "../convex/internal/eventRepairs/sourceBoundEmptyV2Venue.ts";

const fields = {
  rawVenue: "Baza",
  normalizedVenue: "",
  rowSourceText: "Wednesday cinema at Baza",
};
const raw = {
  extraction_contract_version: "event_evidence_v2",
  is_event: true,
  venue: "Baza",
  source_conflicts: [],
  shared_schedule_context: {
    venue: { applies_to_all: true, value: "Baza" },
  },
  schedule_entries: [
    { source_text: "Wednesday cinema at Baza", venue: "Baza" },
    { source_text: "Thursday show at Another Club", venue: "Another Club" },
  ],
};

assert.deepEqual(
  sourceBoundEmptyV2VenueClaimsForTesting(fields, raw),
  ["Baza"],
  "Only the selected schedule child's venue may be bound to this event.",
);
assert.deepEqual(
  sourceBoundEmptyV2VenueClaimsForTesting(fields, {
    ...raw,
    schedule_entries: [
      { source_text: "Wednesday cinema at Baza", venue: "Another Club" },
    ],
  }),
  ["Baza", "Another Club"],
  "An offsite child claim must reach the catalog resolution gate.",
);
assert.deepEqual(
  sourceBoundEmptyV2VenueClaimsForTesting(fields, {
    ...raw,
    schedule_entries: [
      raw.schedule_entries[0],
      raw.schedule_entries[0],
    ],
  }),
  ["Baza"],
  "Repeated source text is safe when every matching row states the same venue.",
);
assert.deepEqual(
  sourceBoundEmptyV2VenueClaimsForTesting(fields, {
    ...raw,
    schedule_entries: [
      raw.schedule_entries[0],
      { ...raw.schedule_entries[0], venue: "Another Club" },
    ],
  }),
  ["Baza", "Another Club"],
  "Every repeated-row venue claim must reach the catalog resolution gate.",
);
assert.equal(
  sourceBoundEmptyV2VenueClaimsForTesting(fields, {
    ...raw,
    schedule_entries: [
      raw.schedule_entries[0],
      { ...raw.schedule_entries[0], venue: "" },
    ],
  }),
  null,
  "Repeated source text with an unlocated child cannot ground one venue.",
);
assert.equal(
  sourceBoundEmptyV2VenueClaimsForTesting(
    { ...fields, rowSourceText: "" },
    raw,
  ),
  null,
  "A multi-row source without an exact row binding stays held.",
);
assert.equal(
  sourceBoundEmptyV2VenueClaimsForTesting(fields, {
    ...raw,
    source_conflicts: [{ field: "venue", reason: "poster and caption differ" }],
  }),
  null,
  "A direct venue conflict stays held.",
);
assert.equal(
  sourceBoundEmptyV2VenueClaimsForTesting(fields, {
    ...raw,
    shared_schedule_context: {
      venue: { applies_to_all: true, value: "Another Club" },
    },
  }).includes("Another Club"),
  true,
  "An offsite shared venue cannot be silently ignored.",
);
assert.equal(
  sourceBoundEmptyV2VenueClaimsForTesting({ ...fields, rawVenue: "" }, raw),
  null,
  "The repair requires an explicit persisted raw venue claim.",
);

console.log("Source-bound empty v2 venue repair QA passed.");
