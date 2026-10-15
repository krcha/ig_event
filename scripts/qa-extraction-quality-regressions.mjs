import assert from "node:assert/strict";

// Load the supported ingestion entrypoint order used by the existing QA suites.
import "../convex/events.ts";
import { EVENT_EXTRACTION_POLICY_VERSION, parseExtractedEventData } from "../lib/ai/extract-event-data.ts";
import { findScopedBranchVenueEvidence } from "../lib/pipeline/ingestion/scoped-branch-venue-evidence.ts";
import { getDayScopedSourceBlocks, sourceIdentityMatchesSelectedDay } from "../lib/pipeline/ingestion/day-scoped-identity-evidence.ts";
import { hasPerformingArtistEvidence } from "../lib/pipeline/ingestion/performer-credit-evidence.ts";
import { artistIdentityAppearsInText, isVerifiedEventIdentityEvidence, isVerifiedEventVenueEvidence } from "../lib/pipeline/ingestion/structured-fact-verification.ts";
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

const komitetNames = { komitet_betonhala: "Komitet Beograd", betonbelgrade: "Beton" };
const komitetPost = makePost({
  handle: "komitet_betonhala",
  sourceUrl: "https://www.instagram.com/p/qa-komitet-waterfront-area/",
  caption: "SUBOTA I 17.10. I 23H\nDance like nobody's watching w/ @rush__band",
});
function komitetFacts(sourceText, rowVenue = "Komitet Beograd") {
  return produceStructuredFactsForInsert(komitetPost, extraction([entry({
    date: "2026-10-17", dateText: "17. OKTOBAR", time: "23:00", title: "RUSH BEND",
    artists: ["Rush Bend"], venue: rowVenue, sourceText,
  })], "live music"), IMAGE_URL, komitetNames, {}, komitetNames, {
    eventDateFilterNow: NOW, sourceRolesByHandle: { komitet_betonhala: "venue" },
  });
}
const [waterfrontAnnouncement] = komitetFacts("SUBOTA | RUSH BEND | 17. OKTOBAR | 23:00 | BETON HALA · BEOGRAD");
assert.equal(waterfrontAnnouncement.facts.venueClaim, "Komitet Beograd", "Beton Hala is not proof of an event at the separately named Beton club.");
assert.equal(waterfrontAnnouncement.normalizedFields.venueAccountFallbackVersion, 1);
const [offsiteBeton] = komitetFacts("17. OKTOBAR RUSH BEND 23:00 at Beton", "Beton");
assert.equal(offsiteBeton.facts.venueClaim, "Beton", "An explicit physical venue claim must still override the source account.");

const vjeranNames = { vjeran_pas: "Vjeran Pas" };
const vjeranPost = makePost({
  handle: "vjeran_pas",
  sourceUrl: "https://www.instagram.com/p/qa-vjeran-day-lineup/",
  caption: "PETAK: @lidsav\nSUBOTA: @nikola.djacic",
});
const vjeranRows = [
  entry({ date: "2026-10-16", title: "@lidsav", artists: ["@lidsav"], venue: "Vjeran Pas", sourceText: "PETAK: @lidsav" }),
  entry({ date: "2026-10-17", title: "NIKKI", artists: ["Vjeran Pas", "@nikola.djacic"], venue: "Vjeran Pas", sourceText: "SUBOTA: @nikola.djacic" }),
];
function vjeranFacts(rows, post = vjeranPost, names = vjeranNames) {
  return produceStructuredFactsForInsert(post, extraction(rows), IMAGE_URL, names, {}, names, {
    eventDateFilterNow: NOW, sourceRolesByHandle: { vjeran_pas: "venue" },
  });
}
const vjeran = vjeranFacts(vjeranRows);
assert.deepEqual(vjeran.map((result) => [result.facts.localDate, result.facts.artistClaims]), [
  ["2026-10-16", ["@lidsav"]], ["2026-10-17", ["@nikola.djacic"]],
], "A venue logo cannot become an extra performer, and weekday lineups must remain separate.");
assert.equal(vjeran[1].normalizedFields.artistsWereSanitized, true);
const oldDisplayName = { vjeran_pas: "Svašta nam se dogadja" };
const [oldVenueName] = vjeranFacts([{ ...vjeranRows[1], venue: oldDisplayName.vjeran_pas }], vjeranPost, oldDisplayName);
assert.deepEqual(oldVenueName.facts.artistClaims, ["@nikola.djacic"], "The authentic venue handle must distinguish its logo even when its observed display name is prose.");
const [actuallyBilledNamesake] = vjeranFacts([
  { ...vjeranRows[1], source_text: "SUBOTA: Vjeran Pas + @nikola.djacic" },
], { ...vjeranPost, caption: "SUBOTA: Vjeran Pas + @nikola.djacic" });
assert.deepEqual(actuallyBilledNamesake.facts.artistClaims, ["Vjeran Pas", "@nikola.djacic"], "An act explicitly billed in the same caption row must be preserved even when its name matches the venue.");
const [unboundCaptionRow] = vjeranFacts([{ ...vjeranRows[1], source_text: "NIKKI | VJERAN PAS | 17.10.2026." }]);
assert.deepEqual(unboundCaptionRow.facts.artistClaims, ["Vjeran Pas", "@nikola.djacic"], "Unrelated or whole-post caption evidence cannot silently rewrite a poster lineup.");

const broadCaption = "Friday 16.10.2026 | Event One | Artist Friday\nSaturday 17.10.2026 | Event Two | Artist Saturday";
const broadPost = makePost({ handle: "qa_day_scope", sourceUrl: "https://www.instagram.com/p/qa-broad-caption-day-scope/", caption: broadCaption });
const broadRows = [
  entry({ date: "2026-10-16", dateText: "16.10.2026", source: "caption", title: "Event One", artists: ["Artist Saturday"], sourceText: broadCaption }),
  entry({ date: "2026-10-17", dateText: "17.10.2026", source: "caption", title: "Event Two", artists: ["Artist Saturday"], sourceText: broadCaption }),
];
const broadResults = prepare(broadPost, broadRows, "QA Day Scope");
assert.equal(broadResults[0].normalizedFields.identityEvidenceVerified, false, "A whole-caption quote cannot bill Saturday's artist for Friday.");
assert.equal(broadResults[0].event.status, "pending");
assert.equal(broadResults[1].normalizedFields.identityEvidenceVerified, false, "An overbroad row whose date normalization selected Friday cannot bill Saturday's identity.");
const correctBroadRows = broadRows.map((row, index) => ({ ...row, source_text: broadCaption.split("\n")[index], artists: [index ? "Artist Saturday" : "Artist Friday"] }));
assert.ok(prepare(broadPost, correctBroadRows, "QA Day Scope").every((result) => result.normalizedFields.identityEvidenceVerified));

const weekdayCaption = "PETAK: Event One with Artist Friday\nSUBOTA: Event Two with Artist Saturday";
const weekdayPost = { ...broadPost, caption: weekdayCaption };
const weekdayRows = broadRows.map((row) => ({ ...row, source_text: weekdayCaption, date_evidence: { ...row.date_evidence, source: "poster" } }));
// Persisted caption snippets are checked even when another retained image proves the date.
const weekdayExtraction = extraction(weekdayRows);
weekdayExtraction.field_confirmation.artists = { confidence: 0.9, found_in: ["caption"], evidence: weekdayCaption, evidence_snippets: [{ source: "caption", text: weekdayCaption }], notes: "" };
const verificationOptions = {
  extracted: weekdayExtraction, title: "Event One", artists: ["Artist Saturday"], titleUsedFallback: false,
  venue: "QA Day Scope", splitSourceLine: weekdayCaption, singleScheduleEntrySource: false,
  splitEvidenceSource: "caption", post: weekdayPost, hasPoster: true, resolvedDate: "2026-10-16",
};
assert.equal(isVerifiedEventIdentityEvidence(verificationOptions), false, "Weekday-only headings must also isolate the selected day.");
assert.equal(isVerifiedEventIdentityEvidence({ ...verificationOptions, artists: ["Artist Friday"] }), true);
assert.equal(isVerifiedEventIdentityEvidence({ ...verificationOptions, resolvedDate: "2026-10-17" }), false, "Friday's title must not move to Saturday through a broad quote.");

for (const caption of [
  "Artist Common plays both days\nFriday: Event One\nSaturday: Event Two",
  "Event One both days\nHosted by Artist Friday\nFriday: 12:00\nSaturday: 14:00",
  "Event One with Artist Friday and DJ Sunday, 16.10.2026, sessions at 12:00 and 14:00",
  "16.10.2026 Event One with Artist Friday, 12:00\n16.10.2026 Event One with Artist Friday, 14:00",
]) {
  const artists = caption.includes("Artist Common") ? ["Artist Common"] : ["Artist Friday"];
  assert.equal(isVerifiedEventIdentityEvidence({ ...verificationOptions, artists, post: { ...weekdayPost, caption }, splitSourceLine: caption }), true,
    "Explicit shared acts, same-day sessions and a weekday in an artist name must remain valid.");
}
const sharedCaption = "Event Shared with Artist Shared on 16 and 17 October 2026";
const sharedRows = ["2026-10-16", "2026-10-17"].map((date) => entry({ date, title: "Event Shared", artists: ["Artist Shared"], sourceText: sharedCaption, source: "caption" }));
const sharedExtraction = extraction(sharedRows);
sharedExtraction.title = "Event Shared";
sharedExtraction.artists = ["Artist Shared"];
sharedExtraction.date_evidence = { exact_text: "16 and 17 October 2026", source: "caption", is_relative: false, resolved_date: "2026-10-16" };
assert.equal(isVerifiedEventIdentityEvidence({ ...verificationOptions, extracted: sharedExtraction, title: "Event Shared", artists: ["Artist Shared"], splitSourceLine: sharedCaption, post: { ...weekdayPost, caption: sharedCaption } }), true,
  "An exact common identity applying to both enumerated dates must remain verified.");

const weekdayActCaption = "PETAK: Event One\nSunday Boys\nSUBOTA: Event Two";
assert.deepEqual(getDayScopedSourceBlocks(weekdayActCaption, broadPost.postedAt).map((block) => [block.weekday, block.text]), [
  [5, "PETAK: Event One\nSunday Boys"], [6, "SUBOTA: Event Two"],
], "A Friday act called Sunday Boys must not create a Sunday schedule heading.");
assert.equal(isVerifiedEventIdentityEvidence({ ...verificationOptions, artists: ["Sunday Boys"], post: { ...weekdayPost, caption: weekdayActCaption }, splitSourceLine: weekdayActCaption }), true);
assert.equal(isVerifiedEventIdentityEvidence({ ...verificationOptions, title: "Event Two", artists: ["Sunday Boys"], resolvedDate: "2026-10-17", post: { ...weekdayPost, caption: weekdayActCaption }, splitSourceLine: weekdayActCaption }), false);
for (const [heading, expectedWeekday] of [["PETAK: Event One", 5], ["SATURDAY17.10.2026", 6], ["Friday | DJ One", 5], ["Sunday", 0], ["Petak @artist", 5]]) {
  assert.equal(getDayScopedSourceBlocks(heading, broadPost.postedAt)[0]?.weekday, expectedWeekday, `Explicit weekday heading must remain recognized: ${heading}`);
}

const preheaderRosterCaption = "Lineup: Alice, Bob\nPETAK: Event One with Alice\nSUBOTA: Event Two with Bob";
for (const [resolvedDate, title, borrowedArtist, actualArtist] of [
  ["2026-10-16", "Event One", "Bob", "Alice"],
  ["2026-10-17", "Event Two", "Alice", "Bob"],
]) {
  const options = { ...verificationOptions, resolvedDate, title, artists: [borrowedArtist], post: { ...weekdayPost, caption: preheaderRosterCaption }, splitSourceLine: preheaderRosterCaption };
  assert.equal(isVerifiedEventIdentityEvidence(options), false, "An introductory lineup roster cannot move an act to the other day.");
  assert.equal(isVerifiedEventIdentityEvidence({ ...options, artists: [actualArtist] }), true, "The actual row-local artist remains verified despite an introductory roster.");
}
const hostedSchedule = "Conversation club hosted by Alice\nPETAK: Event One\nSUBOTA: Event Two";
assert.equal(isVerifiedEventIdentityEvidence({ ...verificationOptions, artists: ["Alice"], post: { ...weekdayPost, caption: hostedSchedule }, splitSourceLine: hostedSchedule }), true,
  "An explicitly named common host may participate in both scheduled sessions.");
const commonHostCaption = "Приглашаем вас на разговорный клуб с Альберто @alberto_aprile — носителем итальянского языка.\n• Понедельник — 14:00\n• Среда — 19:00";
for (const selectedDate of ["2026-10-19", "2026-10-21"]) {
  assert.equal(sourceIdentityMatchesSelectedDay({ sourceText: commonHostCaption, selectedDate, postedAt: broadPost.postedAt, identity: "Alberto Aprile", identityAppearsInText: artistIdentityAppearsInText }), true,
    "COMMON's actual introductory language-club leader evidence remains common to Monday and Wednesday.");
}

const creditPost = makePost({ handle: "qa_credit_scope", sourceUrl: "https://www.instagram.com/p/qa-creator-credit-roles/" });
const moliereArtists = ["DOVE ATTIA", "LADISLAS CHOLLAT", "ROMAIN R.B"];
const moliereCreditText = "MOLIÈRE 17.10.2026\nAUTOR: DOVE ATTIA\nREDITELJ: LADISLAS CHOLLAT\nKOREOGRAF: ROMAIN R.B";
const [moliereCredits] = prepare(creditPost, [entry({ date: "2026-10-17", dateText: "17.10.2026", title: "MOLIÈRE", artists: moliereArtists, sourceText: moliereCreditText })], "QA Credit Scope", "arts & culture");
assert.equal(moliereCredits.normalizedFields.identityEvidenceVerified, false, "A creator credit cannot prove an appearance in the musical.");
assert.equal(moliereCredits.event.status, "pending");
assert.deepEqual(moliereCredits.event.artists, moliereArtists, "Unsupported credit roles must require review rather than silently rewriting artists.");

const symphonyContext = "Simfonijski orkestar i hor izvode najveće rock hitove.";
const symphonyProof = "ROCK SYMPHONY 17.10.2026\nPERFORMANS SIMFONIJSKOG ORKESTRA, HORA I VOKALA RONI ROMERA\nMUSIC BY AC/DC | QUEEN";
const symphonyArtists = ["RONI ROMERA", "AC/DC", "QUEEN"];
const [symphonyRepertoire] = prepare({ ...creditPost, caption: symphonyContext }, [entry({ date: "2026-10-17", dateText: "17.10.2026", title: "ROCK SYMPHONY", artists: symphonyArtists, sourceText: symphonyProof })], "QA Credit Scope", "live music");
assert.equal(symphonyRepertoire.normalizedFields.identityEvidenceVerified, false, "Music-by repertoire in a symphonic program cannot bill the original bands as guests.");
assert.equal(symphonyRepertoire.event.status, "pending");
assert.deepEqual(symphonyRepertoire.event.artists, symphonyArtists);
const [actualVocalist] = prepare({ ...creditPost, caption: symphonyContext }, [entry({ date: "2026-10-17", dateText: "17.10.2026", title: "ROCK SYMPHONY", artists: ["RONI ROMERA"], sourceText: symphonyProof })], "QA Credit Scope", "live music");
assert.equal(actualVocalist.normalizedFields.identityEvidenceVerified, true, "A separately billed vocalist stays verified alongside the repertoire heading.");

function artistProof(text, artist, context = text) {
  return hasPerformingArtistEvidence({ text, artist, context, identityAppearsInText: artistIdentityAppearsInText });
}
for (const [text, artist, expected, context] of [
  ["MUSIC BY DJ One", "DJ One", true],
  ["MUSIC BY Alice", "Alice", true],
  ["MUSIC BY DJ One", "DJ One", true, "Rock Symphony guest DJ set"],
  ["TRIBUTE TO QUEEN | MUSIC BY QUEEN", "QUEEN", false],
  ["REPERTOIRE: QUEEN | TINA TURNER", "TINA TURNER", false],
  ["AUTOR: Alice\nLINEUP: Alice", "Alice", true],
  ["AUTOR\nDOVE ATTIA", "DOVE ATTIA", false],
  ["Autor\nDove Attia", "Dove Attia", false],
  ["AUTHOR Alice", "Alice", false],
  ["DIRECTOR\nAlice\nLINEUP: DJ One", "Alice", false],
  ["KOREOGRAF ROMAIN R.B", "ROMAIN R.B", false],
  ["AUTHOR Alice\nLINEUP: Alice", "Alice", true],
  ["Author & Punisher", "Author & Punisher", true],
  ["AUTHOR & PUNISHER\nPHOTO: Alice", "Author & Punisher", true],
  ["Director's Cut", "Director's Cut", true],
  ["The Director\nAUTHOR Alice", "The Director", true],
  ["Written by Alice", "Alice", false],
  ["Directed by Alice", "Alice", false],
  ["Composed by Alice", "Alice", false],
  ["AUTOR: Alice\nDJ One live", "Alice", false],
  ["AUTOR: Alice\nDJ One live", "DJ One", true],
  ["DJ One\nPHOTO: Alice", "DJ One", true],
  ["DJ One\nPHOTO: Alice", "Alice", false],
  ["MUSIC BY QUEEN | GUEST: Alice", "QUEEN", false, "Tribute orchestra"],
  ["MUSIC BY QUEEN | GUEST: Alice", "Alice", true, "Tribute orchestra"],
  ["MUSIC BY QUEEN | SPECIAL GUEST Alice", "Alice", true, "Tribute orchestra"],
  ["MUSIC BY QUEEN | LINEUP: Alice", "Alice", true, "Tribute orchestra"],
]) assert.equal(artistProof(text, artist, context), expected, `Artist-role scope: ${artist} in ${text}`);

// A bare caption snippet must not hide the role in the persisted source.
const captionCreditExtraction = extraction([entry({ date: "2026-10-17", title: "Event One", artists: ["Alice"], sourceText: "Event One 17.10.2026", source: "caption" })]);
captionCreditExtraction.field_confirmation.artists = { confidence: 0.99, found_in: ["caption"], evidence: "Alice", evidence_snippets: [{ source: "caption", text: "Alice" }], notes: "" };
const captionCreditOptions = { ...verificationOptions, extracted: captionCreditExtraction, artists: ["Alice"], splitSourceLine: "Event One 17.10.2026", singleScheduleEntrySource: true, post: { ...creditPost, caption: "Event One 17.10.2026\nAUTOR: Alice" }, resolvedDate: "2026-10-17" };
assert.equal(isVerifiedEventIdentityEvidence(captionCreditOptions), false, "A narrow name-only quote cannot hide its actual caption credit label.");
assert.equal(isVerifiedEventIdentityEvidence({ ...captionCreditOptions, post: { ...captionCreditOptions.post, caption: `${captionCreditOptions.post.caption}\nLINEUP: Alice` } }), true, "The same creator may also be separately billed as appearing.");

console.log("QA passed: source-scoped acts, independent room programs, sessions, venue precedence, day-bound identities and performer/credit roles.");
