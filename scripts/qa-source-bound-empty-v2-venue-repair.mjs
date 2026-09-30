import assert from "node:assert/strict";

import { buildInstagramSourceOccurrenceFingerprint } from "../lib/domain/occurrences/source-fingerprint.ts";
import {
  currentSecondarySourceVenueClaimsForTesting,
  sourceBoundEmptyV2VenueClaimsForTesting,
} from "../convex/internal/eventRepairs/sourceBoundEmptyV2Venue.ts";

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

const secondaryRaw = {
  ...raw,
  source_url: "https://www.instagram.com/p/SECONDARY1/",
  source_caption: "Two Baza events",
  schedule_entries: raw.schedule_entries.map((entry) => ({
    ...entry,
    venue: "Baza",
  })),
};
const secondaryPost = {
  handle: "baza",
  username: "baza",
  postId: "secondary-123",
  instagramPostUrl: "https://www.instagram.com/p/SECONDARY1/",
  canonicalSourceUrl: "https://www.instagram.com/p/SECONDARY1/",
  caption: "Two Baza events",
  altText: "",
  locationName: "",
  sourceRevision: 1,
  analysisRevision: 1,
  analysisContractVersion: "event_evidence_v2",
  analysisIsEvent: true,
  analysisModel: "gpt-5-mini",
  analysisResultJson: JSON.stringify(secondaryRaw),
};
const secondaryLink = {
  sourceIdentity: "instagram-source-identity-v1:SECONDARY1",
  sourceFingerprint: buildInstagramSourceOccurrenceFingerprint(secondaryPost),
};
assert.deepEqual(
  currentSecondarySourceVenueClaimsForTesting(
    secondaryPost,
    secondaryLink,
    "baza",
  ),
  ["Baza"],
  "A second saved source with current analysis can attest the same venue.",
);
assert.equal(
  currentSecondarySourceVenueClaimsForTesting(
    secondaryPost,
    { ...secondaryLink, sourceFingerprint: "stale" },
    "baza",
  ),
  null,
  "A stale receipt fingerprint cannot authorize venue rebinding.",
);
assert.equal(
  currentSecondarySourceVenueClaimsForTesting(
    { ...secondaryPost, analysisRevision: 0 },
    secondaryLink,
    "baza",
  ),
  null,
  "The secondary GPT analysis must match the current source revision.",
);
assert.equal(
  currentSecondarySourceVenueClaimsForTesting(
    {
      ...secondaryPost,
      analysisResultJson: JSON.stringify({
        ...secondaryRaw,
        source_url: "https://www.instagram.com/p/OTHERPOST/",
      }),
    },
    secondaryLink,
    "baza",
  ),
  null,
  "The analysis must attest its own saved secondary post.",
);
assert.equal(
  currentSecondarySourceVenueClaimsForTesting(
    { ...secondaryPost, handle: "other_account" },
    secondaryLink,
    "baza",
  ),
  null,
  "A different posting account cannot borrow the venue source.",
);
assert.equal(
  currentSecondarySourceVenueClaimsForTesting(
    {
      ...secondaryPost,
      analysisResultJson: JSON.stringify({
        ...secondaryRaw,
        schedule_entries: [
          secondaryRaw.schedule_entries[0],
          { ...secondaryRaw.schedule_entries[1], venue: "" },
        ],
      }),
    },
    secondaryLink,
    "baza",
  ),
  null,
  "Every secondary schedule row needs a physical venue claim.",
);
assert.deepEqual(
  currentSecondarySourceVenueClaimsForTesting(
    {
      ...secondaryPost,
      analysisResultJson: JSON.stringify({
        ...secondaryRaw,
        schedule_entries: [
          secondaryRaw.schedule_entries[0],
          { ...secondaryRaw.schedule_entries[1], venue: "Another Club" },
        ],
      }),
    },
    secondaryLink,
    "baza",
  ),
  ["Baza", "Another Club"],
  "An offsite secondary claim must reach the catalog resolution gate.",
);

console.log("Source-bound empty v2 venue repair QA passed.");
