import assert from "node:assert/strict";
import {
  EVENT_EXTRACTION_SYSTEM_PROMPT,
  buildEventExtractionUserPrompt,
} from "../lib/ai/event-extraction-prompt.ts";
import {
  AUTO_APPROVE_CONFIDENCE_THRESHOLD,
  calculateModerationConfidenceScore,
  normalizeConfidencePayload,
  normalizeConfidenceScore,
  shouldAutoApproveConfidenceScore,
} from "../lib/utils/confidence.ts";
import {
  buildCanonicalVenueNamesByHandle,
  normalizeExtractedArtists,
  normalizeExtractedDescription,
  normalizeVenueFromEvidence,
} from "../lib/pipeline/venue-normalization.ts";

const STATIC_VENUE_BY_HANDLE = {
  "20_44.nightclub": "Klub 20/44",
  kcgrad: "KC Grad",
};

function runPromptQa() {
  assert.match(
    EVENT_EXTRACTION_SYSTEM_PROMPT,
    /standardized venue display name/i,
    "Prompt must require venue standardization.",
  );
  assert.match(
    EVENT_EXTRACTION_SYSTEM_PROMPT,
    /Deduplicate artists/i,
    "Prompt must require artist deduplication.",
  );
  assert.match(
    EVENT_EXTRACTION_SYSTEM_PROMPT,
    /Do not include date, time, price, venue, address/i,
    "Prompt must keep descriptions factual and compact.",
  );
  assert.match(
    EVENT_EXTRACTION_SYSTEM_PROMPT,
    /schedule_entries/i,
    "Prompt must require structured multi-date schedule extraction.",
  );
  assert.match(
    EVENT_EXTRACTION_SYSTEM_PROMPT,
    /Do not collapse a multi-date venue schedule/i,
    "Prompt must forbid collapsing venue schedules into one event.",
  );
  assert.match(
    EVENT_EXTRACTION_SYSTEM_PROMPT,
    /0\.00 to 1\.00 inclusive/i,
    "Prompt must require confidence values in the 0.00-1.00 range.",
  );

  const userPrompt = buildEventExtractionUserPrompt({
    instagramHandle: "kcgrad",
    instagramPostUrl: "https://instagram.com/p/example",
    instagramPostTimestamp: "2026-03-08T20:00:00.000Z",
    instagramCaption: "Friday night at Grad",
    instagramAltText: "Poster text says Friday night at Grad with DJ Python.",
    instagramLocationName: "KC Grad",
    canonicalVenueName: "KC Grad",
    sourceImageUrl: "https://cdn.example.com/poster.jpg",
  });

  assert.match(userPrompt, /Instagram location tag: KC Grad/);
  assert.match(userPrompt, /Canonical venue hint: KC Grad/);
  assert.match(userPrompt, /Instagram alt text:/);
  assert.match(userPrompt, /schedule_entries/i);
}

function runVenueQa() {
  const canonicalVenueNamesByHandle = buildCanonicalVenueNamesByHandle([
    { name: "Drugstore", instagramHandle: "drugstore_beograd" },
    { name: "Zappa Baza", instagramHandle: "zappabaza" },
  ]);

  const canonicalFromHandle = normalizeVenueFromEvidence({
    handle: "20_44.nightclub",
    rawModelVenue: "20/44",
    locationName: "Belgrade",
    canonicalVenueNamesByHandle,
    staticVenueByHandle: STATIC_VENUE_BY_HANDLE,
  });
  assert.equal(canonicalFromHandle.venue, "Klub 20/44");
  assert.equal(canonicalFromHandle.source, "model");

  const canonicalFromLocation = normalizeVenueFromEvidence({
    handle: "random_promoter",
    rawModelVenue: "",
    locationName: "Zappa Baza",
    canonicalVenueNamesByHandle,
    staticVenueByHandle: STATIC_VENUE_BY_HANDLE,
  });
  assert.equal(canonicalFromLocation.venue, "Zappa Baza");
  assert.equal(canonicalFromLocation.source, "location_name");

  const genericLocationOnly = normalizeVenueFromEvidence({
    handle: "random_promoter",
    rawModelVenue: "Belgrade",
    locationName: "",
    canonicalVenueNamesByHandle,
    staticVenueByHandle: STATIC_VENUE_BY_HANDLE,
  });
  assert.equal(genericLocationOnly.venue, null);
}

function runArtistAndDescriptionQa() {
  assert.deepEqual(
    normalizeExtractedArtists(["  DJ Python  ", "dj python", "LINEUP", "Baba Ali"]),
    ["DJ Python", "Baba Ali"],
  );
  assert.equal(
    normalizeExtractedDescription("  Live set   with   two guests , all night.  "),
    "Live set with two guests, all night.",
  );
}

function runConfidenceQa() {
  assert.equal(normalizeConfidenceScore(0.7), 0.7);
  assert.equal(normalizeConfidenceScore("0.95"), 0.95);
  assert.equal(normalizeConfidenceScore(95), 0.95);
  assert.equal(normalizeConfidenceScore("100"), 1);
  assert.equal(normalizeConfidenceScore(-1), null);

  const normalized = normalizeConfidencePayload({
    confidence: 95,
    field_confirmation: {
      title: { confidence: "90" },
      location: { confidence: 0.85 },
    },
  });
  assert.deepEqual(normalized, {
    confidence: 0.95,
    field_confirmation: {
      title: { confidence: 0.9 },
      location: { confidence: 0.85 },
    },
  });

  assert.equal(
    calculateModerationConfidenceScore(0.95, {
      hasSuspectedDuplicates: false,
      missingImage: false,
    }),
    0.95,
  );
  assert.equal(
    calculateModerationConfidenceScore(0.95, {
      hasSuspectedDuplicates: true,
      missingImage: false,
    }),
    0.48,
  );
  assert.equal(
    calculateModerationConfidenceScore(0.95, {
      hasSuspectedDuplicates: false,
      missingImage: true,
    }),
    0.75,
  );
  assert.equal(
    shouldAutoApproveConfidenceScore(AUTO_APPROVE_CONFIDENCE_THRESHOLD),
    false,
  );
  assert.equal(shouldAutoApproveConfidenceScore(0.91), true);
}

runPromptQa();
runVenueQa();
runArtistAndDescriptionQa();
runConfidenceQa();

console.log("QA passed: extraction prompt, venue standardization, artists, and description checks.");
