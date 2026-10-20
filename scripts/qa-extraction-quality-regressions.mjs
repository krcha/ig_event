import assert from "node:assert/strict";

// Load the supported ingestion entrypoint order used by the existing QA suites.
import "../convex/events.ts";
import { EVENT_EXTRACTION_POLICY_VERSION, parseExtractedEventData } from "../lib/ai/extract-event-data.ts";
import { findScopedBranchVenueEvidence } from "../lib/pipeline/ingestion/scoped-branch-venue-evidence.ts";
import { isVerifiedEventVenueEvidence } from "../lib/pipeline/ingestion/structured-fact-verification.ts";
import { normalizeVenue, produceStructuredFactsForInsert } from "../lib/pipeline/ingestion/structured-facts.ts";
import { buildIngestionVenueResolver, findPositiveLocativeVenueHandleEvidence } from "../lib/domain/venues/index.ts";
import {
  bindSourceOccurrenceMetadata,
  prepareEventsForInsert,
} from "../lib/pipeline/run-instagram-ingestion.ts";

const NOW = new Date("2026-10-01T12:00:00.000Z");
const IMAGE_URL = "https://example.com/qa-reviewed-poster.jpg";

// Human-labeled components of the public sources reviewed on October 12.
// These deterministic fixtures protect normalization/grouping; they do not
// claim to exercise model vision. The shadow runner evaluates full real posts.
function makePost({ handle, sourceUrl, caption = "" }) {
  return {
    caption,
    altText: null,
    locationName: null,
    username: handle,
    handle,
    postId: sourceUrl.split("/").filter(Boolean).at(-1),
    instagramPostUrl: sourceUrl,
    postedAt: "2026-09-30T12:00:00.000Z",
    imageUrl: IMAGE_URL,
    imageUrls: [IMAGE_URL],
    postType: "image",
  };
}

function entry({
  date,
  title,
  artists = [],
  venue = "",
  time = "",
  description = "",
  sourceText,
  dateText = date,
  timeText = time,
  source = "poster",
}) {
  return {
    date,
    time,
    venue,
    title,
    artists,
    description,
    source_text: sourceText,
    date_evidence: {
      exact_text: dateText,
      source,
      is_relative: false,
      resolved_date: date,
    },
    time_evidence: {
      status: time ? "start_time_stated" : "not_stated",
      exact_text: time ? timeText : "",
      source: time ? source : "unknown",
    },
  };
}

function extraction(rows, category = "nightlife") {
  return parseExtractedEventData({
    extraction_contract_version: "event_evidence_v2",
    _extractionPolicyVersion: EVENT_EXTRACTION_POLICY_VERSION,
    is_event: true,
    non_event_reason: "",
    title: "",
    date: "",
    time: "",
    venue: "",
    city: "Belgrade",
    country: "Serbia",
    price: "",
    currency: "",
    artists: [],
    category,
    description: "",
    confidence: 0.6,
    reasoning_notes: "Human-labeled normalization fixture.",
    source_caption: "",
    source_url: "",
    date_evidence: {
      exact_text: "",
      source: "unknown",
      is_relative: false,
      resolved_date: "",
    },
    time_evidence: {
      status: "not_stated",
      exact_text: "",
      source: "unknown",
    },
    source_conflicts: [],
    shared_schedule_context: Object.fromEntries(
      ["venue", "time"].map((field) => [field, {
        applies_to_all: false,
        value: "",
        evidence: "",
        source: "unknown",
      }]),
    ),
    schedule_entries: rows,
    field_confirmation: Object.fromEntries(
      ["title", "location", "location_name", "price", "start_time", "short_description", "artists"].map(
        (field) => [field, {
          confidence: 0,
          found_in: [],
          evidence: "",
          evidence_snippets: [],
          notes: "",
        }],
      ),
    ),
  });
}

function prepare(post, rows, venue, category = "nightlife") {
  const mappings = { [post.username]: venue };
  const results = prepareEventsForInsert(
    post,
    extraction(rows, category),
    IMAGE_URL,
    mappings,
    {},
    mappings,
    {
      eventDateFilterNow: NOW,
      sourceRolesByHandle: { [post.username]: "venue" },
    },
  );
  assert.ok(results.every((result) => result.kind === "ok"), "Supported fixtures must survive preparation.");
  const bound = bindSourceOccurrenceMetadata(post, results);
  assert.equal(
    new Set(bound.map((result) => result.normalizedFields.sourceOccurrenceKey)).size,
    rows.length,
    `Independently attendable sessions must have distinct occurrence keys: ${JSON.stringify(bound.map(({ event, normalizedFields }) => ({ date: event.date, time: event.time, venue: event.venue, key: normalizedFields.sourceOccurrenceKey })))}`,
  );
  return bound;
}

const dubPost = makePost({
  handle: "dubgastropub",
  sourceUrl: "https://www.instagram.com/p/DdugAI8Et6q/",
  caption: "Sezona svirki pocinje!",
});
const dubActs = [
  ["2026-10-16", "ARHIVATORI"],
  ["2026-10-17", "DJ STE♡A"],
  ["2026-10-23", "MAKAO"],
  ["2026-10-24", "DJ TODOR"],
  ["2026-10-30", "DZEPOVI"],
  ["2026-10-31", "DJ PM"],
];
const dubRows = dubActs.map(([date, artist]) => entry({
  date,
  title: artist,
  artists: [artist],
  dateText: `${date.slice(8)}/10`,
  sourceText: `${date.slice(8)}/10 ${artist}`,
}));
const dub = prepare(dubPost, dubRows, "Dub Gastro Pub", "live music");
assert.deepEqual(
  dub.map(({ event }) => [event.date, event.artists]),
  dubActs.map(([date, artist]) => [date, [artist]]),
  "Adjacent Friday/Saturday dates must not inherit one another's billed acts.",
);

const roomPost = makePost({
  handle: "vrtoglavica",
  sourceUrl: "https://www.instagram.com/p/DeTQmcyCvrM/",
});
const roomRows = [
  entry({
    date: "2026-10-17",
    dateText: "17.10.",
    title: "LOVE CATZ",
    artists: ["GOXY", "DARK ENERGY"],
    description: "Gornji program.",
    sourceText: "17.10. LOVE CATZ GOXY DARK ENERGY",
  }),
  entry({
    date: "2026-10-17",
    dateText: "17.10.",
    title: "NO LIMIT 90s",
    artists: ["SIRIVS", "KEDLAVI", "HELLSPAWN"],
    description: "Donji program.",
    sourceText: "17.10. NO LIMIT 90s SIRIVS KEDLAVI HELLSPAWN",
  }),
];
const rooms = prepare(roomPost, roomRows, "Vrtoglavica");
assert.deepEqual(
  rooms.map(({ event }) => [event.title, event.artists]),
  roomRows.map((row) => [row.title, row.artists]),
  "Named independent room programs must keep their own titles and lineups.",
);

const museumPost = makePost({
  handle: "kucalegata",
  sourceUrl: "https://www.instagram.com/p/Dd6ZqCCjXQt/",
  caption: "Legat Petra Lubarde\n10. - 11. oktobar 2026. u 13 i 15 sati. Dina Pavic\nGalerija Petra Dobrovica\n10. oktobar 2026. u 13 i 15 sati. Neda Radoicic",
});
const museumRows = [
  ["2026-10-10", "Legat Petra Lubarde", "Dina Pavic"],
  ["2026-10-11", "Legat Petra Lubarde", "Dina Pavic"],
  ["2026-10-10", "Galerija Petra Dobrovica", "Neda Radoicic"],
].flatMap(([date, venue, guide]) => ["13:00", "15:00"].map((time) => entry({
  date,
  title: "Dani evropske bastine",
  venue,
  artists: [guide],
  time,
  dateText: venue === "Legat Petra Lubarde" ? "10. - 11. oktobar 2026." : "10. oktobar 2026.",
  timeText: time === "13:00" ? "u 13" : "15 sati",
  description: `Strucno vodjenje: ${guide}.`,
  sourceText: venue === "Legat Petra Lubarde"
    ? "10. - 11. oktobar 2026. u 13 i 15 sati. Dina Pavic"
    : "10. oktobar 2026. u 13 i 15 sati. Neda Radoicic",
  source: "caption",
})));
const museum = prepare(museumPost, museumRows, "Kuca legata", "arts & culture");
const compareSession = (value) => JSON.stringify(value);
assert.deepEqual(
  museum.map(({ event }) => compareSession([event.date, event.time, event.venue, event.artists])).sort(),
  museumRows.map((row) => compareSession([row.date, row.time, row.venue, row.artists])).sort(),
  "Six independently announced October 10/11 tours must retain time, physical branch and guide.",
);

const branchProofOptions = {
  venue: "Legat Petra Lubarde",
  rowSourceText: museumRows[0].source_text,
  rowDateText: museumRows[0].date_evidence.exact_text,
  source: "caption",
  sourceText: museumPost.caption,
  declaredVenues: museumRows.map((row) => row.venue),
};
assert.deepEqual(findScopedBranchVenueEvidence(branchProofOptions), {
  heading: "Legat Petra Lubarde",
  source: "caption",
  rowQuote: museumRows[0].source_text,
});
const prefixedBranchProofOptions = {
  ...branchProofOptions,
  sourceText: `Legat Petra Lubarde\nStručna vođenja:\n${museumRows[0].source_text}`,
  rowSourceText: `Legat Petra Lubarde — Stručna vođenja: ${museumRows[0].source_text}`,
};
assert.equal(findScopedBranchVenueEvidence(prefixedBranchProofOptions)?.rowQuote, museumRows[0].source_text);
assert.equal(findScopedBranchVenueEvidence({
  ...prefixedBranchProofOptions,
  rowSourceText: `Legat Petra Lubarde — Invented program: ${museumRows[0].source_text}`,
}), null, "Only the exact branch and actual section label may be stripped from a model prefix.");
assert.equal(findScopedBranchVenueEvidence({
  ...prefixedBranchProofOptions,
  sourceText: `${prefixedBranchProofOptions.sourceText}\nGalerija Petra Dobrovica\nStručna vođenja:\n${museumRows[0].source_text}`,
}), null, "A synthetic branch prefix must not hide an identically quoted row in another branch.");
for (const overrides of [
  { rowSourceText: "Invented quote" },
  { rowDateText: "12. oktobar 2026." },
  { declaredVenues: ["Galerija Petra Dobrovica"] },
  { sourceText: `Legat Petra Lubarde\nGalerija Other Branch\n${museumRows[0].source_text}` },
  { sourceText: `${museumPost.caption}\nGalerija Petra Dobrovica\n${museumRows[0].source_text}` },
  { sourceText: `Drugstore\n${museumRows[0].source_text}\nLegat Petra Lubarde` },
  { sourceText: `Legat Petra Lubarde\nDrugstore\n${museumRows[0].source_text}` },
]) {
  assert.equal(
    findScopedBranchVenueEvidence({ ...branchProofOptions, ...overrides }),
    null,
    "Wrong, noncontiguous, ambiguous or intervening branch evidence must fail closed.",
  );
}
const scopedVenueVerification = {
  venue: "Legat Petra Lubarde",
  rawEvidenceValue: "Legat Petra Lubarde",
  extracted: extraction(museumRows, "arts & culture"),
  splitSourceLine: museumRows[0].source_text,
  splitEvidenceSource: "caption",
  post: museumPost,
  hasPoster: false,
  trustedVenueSource: false,
  sharedVenueVerified: false,
  scopedBranchVenueEvidence: { heading: "Legat Petra Lubarde", source: "caption", rowQuote: museumRows[0].source_text },
};
assert.equal(isVerifiedEventVenueEvidence(scopedVenueVerification), true);
assert.equal(isVerifiedEventVenueEvidence({
  ...scopedVenueVerification,
  scopedBranchVenueEvidence: { heading: "Galerija Petra Dobrovica", source: "caption", rowQuote: museumRows[0].source_text },
}), false, "Reverification must reject an altered heading proof.");
const cachedExtraction = { ...scopedVenueVerification.extracted };
delete cachedExtraction._extractionPolicyVersion;
assert.equal(isVerifiedEventVenueEvidence({
  ...scopedVenueVerification,
  extracted: cachedExtraction,
}), false, "A future-policy fallback must not alter historical cached v2 interpretation.");

const handleNames = { clubkult: "KULT", hangar: "Hangar", clubdrugstore: "Drugstore Belgrade", lozionica: "Ložionica" };
const handleResolver = buildIngestionVenueResolver({
  canonicalVenueNamesByHandle: handleNames,
  configuredVenueNamesByHandle: handleNames,
});
const ownHandleOptions = { handle: "clubkult", venueNames: ["KULT"] };
for (const evidenceText of ["not at @clubkult", "thanks @clubkult", "at #clubkult", "@clubkult presents"]) {
  assert.equal(findPositiveLocativeVenueHandleEvidence({ ...ownHandleOptions, evidenceText }), null);
}
assert.equal(findPositiveLocativeVenueHandleEvidence({ ...ownHandleOptions, evidenceText: "Tonight the journey continues at @clubkult" }), "Tonight the journey continues at @clubkult");
const afterpartyPost = makePost({
  handle: "clubkult",
  sourceUrl: "https://www.instagram.com/p/DeTykemIIdZ/",
  caption: "ØOMO doesn’t end at Hangar.\nTonight, the journey continues at @clubkult for the official ØOMO afterparty.",
});
const ownHandleRoles = { clubkult: "venue" };
const locatedAfterparty = normalizeVenue(afterpartyPost, "KULT", handleResolver, ownHandleRoles, "ØOMO AFTERPARTY", { allowOwnLocativeVenueEvidence: true });
assert.equal(locatedAfterparty.venue, "KULT");
assert.equal(locatedAfterparty.source, "evidence_handle");
assert.equal(locatedAfterparty.evidenceHandle, "clubkult");
for (const caption of ["Tonight, not at @clubkult", "Thanks @clubkult", "First at @hangar, then at @clubkult"]) {
  const normalized = normalizeVenue({ ...afterpartyPost, caption }, "KULT", handleResolver, ownHandleRoles, "ØOMO AFTERPARTY", { allowOwnLocativeVenueEvidence: true });
  assert.ok(normalized.source !== "evidence_handle" || normalized.evidenceHandle !== "clubkult", "Negated, casual or competing locations cannot establish an own-handle override.");
}
assert.deepEqual(
  normalizeVenue(afterpartyPost, "KULT", handleResolver, ownHandleRoles, "ØOMO AFTERPARTY"),
  normalizeVenue(afterpartyPost, "KULT", handleResolver, ownHandleRoles, "ØOMO AFTERPARTY", { allowOwnLocativeVenueEvidence: false }),
  "Cached extraction normalization retains its existing behavior.",
);
const roundupPost = makePost({
  handle: "clubdrugstore",
  sourceUrl: "https://www.instagram.com/p/qa-own-handle-roundup/",
  caption: "MESTIZA 2. oktobra at @lozionica.\nDVS1 će 30. oktobra nastupiti u @clubdrugstore",
});
const roundupRows = [
  entry({ date: "2026-10-02", title: "MESTIZA", artists: ["MESTIZA"], venue: "Ložionica", dateText: "2. oktobra", sourceText: "MESTIZA 2. oktobra at @lozionica", source: "caption" }),
  entry({ date: "2026-10-30", title: "DVS1", artists: ["DVS1"], venue: "Drugstore Belgrade", dateText: "30. oktobra", sourceText: "DVS1 će 30. oktobra nastupiti u @clubdrugstore", source: "caption" }),
];
const roundupPrepared = prepareEventsForInsert(roundupPost, extraction(roundupRows), null, handleNames, {}, handleNames, {
  eventDateFilterNow: NOW,
  sourceRolesByHandle: { clubdrugstore: "venue" },
});
assert.deepEqual(roundupPrepared.map(({ event }) => [event.title, event.venue]), [["MESTIZA", "Ložionica"], ["DVS1", "Drugstore Belgrade"]]);
assert.equal(roundupPrepared.find(({ event }) => event.title === "DVS1").normalizedFields.venueEvidenceVerified, true);
const unstampedRoundup = extraction(roundupRows);
delete unstampedRoundup._extractionPolicyVersion;
const oldRoundup = prepareEventsForInsert(roundupPost, unstampedRoundup, IMAGE_URL, handleNames, {}, handleNames, {
  eventDateFilterNow: NOW,
  sourceRolesByHandle: { clubdrugstore: "venue" },
});
assert.equal(oldRoundup.find(({ event }) => event.title === "DVS1").event.venue, "", "Own locative row proof must not reinterpret cached v2 extraction.");

const partyPost = makePost({
  handle: "qa_party_venue",
  sourceUrl: "https://www.instagram.com/p/qa-reviewed-party-control/",
});
const partyRows = [entry({
  date: "2026-10-17",
  dateText: "17.10.2026.",
  time: "22:00-05:00",
  timeText: "22h-05h",
  title: "SOURCE PARTY",
  artists: ["ALPHA", "BETA", "GAMMA"],
  description: "ALPHA 22:00-00:00, BETA 00:00-02:00, GAMMA 02:00-05:00.",
  sourceText: "17.10.2026. SOURCE PARTY 22h-05h ALPHA BETA GAMMA",
})];
const party = prepare(partyPost, partyRows, "QA Party Venue");
assert.equal(party.length, 1, "A parent party must not split into one event per DJ.");
assert.deepEqual(party[0].event.artists, ["ALPHA", "BETA", "GAMMA"]);
assert.equal(party[0].event.time, "22:00-05:00");

const barPost = makePost({
  handle: "bar44_belgrade",
  sourceUrl: "https://www.instagram.com/p/Dd13vBvRHE9/",
});
const bar = prepare(barPost, [
  entry({ date: "2026-10-15", dateText: "15.10.", title: "OPEN DECKS", sourceText: "15.10. OPEN DECKS" }),
  entry({ date: "2026-10-18", dateText: "18.10.", title: "BAR RESIDENTS", sourceText: "18.10. BAR RESIDENTS" }),
], "Bar44");
assert.deepEqual(
  bar.map(({ event }) => event.title),
  ["OPEN DECKS", "BAR RESIDENTS"],
  "Explicit source program names must survive rather than generic weekday fallback titles.",
);

// A musical genre is not placement at a similarly named venue. This reproduces
// the Greasy Gravy hold without depending on live extraction or paid providers.
const accountVenue = "Fabrika Alternativne Kulturne Scene";
const accountPost = makePost({
  handle: "faks_beograd",
  sourceUrl: "https://www.instagram.com/p/qa-known-account-fallback/",
  caption: "Greasy Gravy 14.10.2026. 21:00. Zvuk benda oslanja se na cvrst groove, izrazajan blues i ritmicnost.",
});
const accountNames = { faks_beograd: accountVenue, voxbluesclub: "Vox Blues club" };
function accountFacts({ role = "venue", venue = accountVenue, rowVenue = venue, sharedVenue = "", sourceText = accountPost.caption, snapshot } = {}) {
  const parsed = extraction([entry({
    date: "2026-10-14", dateText: "14.10.2026.", time: "21:00", title: "Greasy Gravy",
    venue: rowVenue, sourceText, source: "caption",
  })], "live music");
  parsed.venue = venue;
  if (sharedVenue) parsed.shared_schedule_context.venue = {
    applies_to_all: true, value: sharedVenue, evidence: sharedVenue, source: "caption",
  };
  return produceStructuredFactsForInsert(
    { ...accountPost, caption: sourceText }, parsed, IMAGE_URL, accountNames, {}, accountNames,
    { eventDateFilterNow: NOW, sourceRolesByHandle: { faks_beograd: role }, venueResolverSnapshot: snapshot },
  );
}
for (const venue of ["", accountVenue]) {
  const [result] = accountFacts({ venue });
  assert.equal(result.kind, "event");
  assert.equal(result.facts.venueClaim, accountVenue);
  assert.equal(result.normalizedFields.normalizedVenue, accountVenue);
  assert.equal(result.normalizedFields.venueAccountFallbackVersion, 1);
  assert.equal(result.normalizedFields.sourceAccountRole, "venue");
  assert.equal(result.normalizedFields.trustedVenueSource, true);
  assert.equal(result.facts.venueHandleClaim, "faks_beograd");
  assert.deepEqual(result.facts.evidence.find((proof) => proof.field === "venue"), {
    exactText: undefined, field: "venue", source: "source_account",
  }, "Account context must not manufacture a caption or poster quote.");
}
for (const role of ["promoter", "unknown"]) {
  const [result] = accountFacts({ role, venue: "" });
  assert.equal(result.facts.venueClaim, "", "An account name cannot supply the physical venue for this source role.");
  assert.equal(result.normalizedFields.venueAccountFallbackVersion, undefined);
}
for (const scope of ["row", "shared", "model"]) {
  const explicitVenue = "Block Bar Radnicki";
  const sourceText = `${accountPost.caption} At ${explicitVenue}.`;
  const [result] = accountFacts({
    venue: scope === "model" ? explicitVenue : "",
    rowVenue: scope === "row" ? explicitVenue : "",
    sharedVenue: scope === "shared" ? explicitVenue : "",
    sourceText,
  });
  assert.equal(result.facts.venueClaim, explicitVenue, `Explicit ${scope} venue must survive account fallback.`);
  assert.equal(result.normalizedFields.venueAccountFallbackVersion, undefined);
}
const namedRoom = `Galerija ${accountVenue}`;
const [room] = accountFacts({ venue: namedRoom, rowVenue: namedRoom, sourceText: `${accountPost.caption} At ${namedRoom}.` });
assert.equal(room.facts.venueClaim, namedRoom, "A named gallery or room must not collapse to its parent account venue.");
assert.equal(room.normalizedFields.venueAccountFallbackVersion, undefined);
const ambiguousAccount = accountFacts({ venue: "", snapshot: {
  venues: [
    { id: "faks-a", name: accountVenue, instagramHandle: "faks_beograd" },
    { id: "faks-b", name: "Other FAKS", instagramHandle: "faks_beograd" },
  ],
  identities: [],
} });
assert.equal(ambiguousAccount[0].facts.venueClaim, "", "Conflicting account ownership must not choose a venue.");
assert.equal(ambiguousAccount[0].normalizedFields.venueAccountFallbackVersion, undefined);

console.log("QA passed: source-scoped acts, independent room programs, tour sessions, party grouping, known-account venue fallback and explicit venue precedence.");
