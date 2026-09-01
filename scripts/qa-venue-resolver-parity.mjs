import assert from "node:assert/strict";

import {
  buildVenueSnapshot,
  resolveVenue,
} from "../lib/domain/venues/venue-resolver.ts";
import {
  buildIngestionVenueResolver,
  resolveIngestionVenue,
} from "../lib/domain/venues/ingestion-adapter.ts";
import {
  buildCanonicalVenueAliasesByHandle,
  buildCanonicalVenueNamesByHandle,
  normalizeVenueFromEvidence,
} from "../lib/pipeline/venue-normalization.ts";
import { resolveVenueForWrite } from "../convex/venueResolver.ts";

const venues = [
  {
    aliases: ["Kulturni centar Grad", "KC Gradu"],
    id: "venue-kc-grad",
    instagramHandle: "kcgrad",
    name: "KC Grad",
  },
  {
    aliases: ["Čilton Bašta", "Čilton Bašti", "Chillton Bashta"],
    id: "venue-chillton-basta",
    instagramHandle: "chillton_bashta",
    name: "Chillton Bašta",
  },
  {
    aliases: ["New Cinema Zvezda"],
    id: "venue-bioskop-zvezda",
    instagramHandle: "novi_bioskop_zvezda",
    name: "Novi Bioskop Zvezda",
  },
  {
    aliases: ["Kolarac Art Bioskop"],
    id: "venue-kolarac",
    instagramHandle: "kolarac_art_bioskop",
    name: "Art bioskop Kolarac",
  },
  {
    aliases: ["Para Klub"],
    id: "venue-para",
    instagramHandle: "para_klub",
    name: "Para Klub",
  },
];
const snapshot = buildVenueSnapshot({ venues });
const canonicalVenueNamesByHandle = buildCanonicalVenueNamesByHandle(venues);
const canonicalVenueAliasesByHandle = buildCanonicalVenueAliasesByHandle(venues);
const ingestionResolver = buildIngestionVenueResolver({
  canonicalVenueAliasesByHandle,
  canonicalVenueNamesByHandle,
});

const firstClassIngestionResolver = buildIngestionVenueResolver({
  canonicalVenueAliasesByHandle: {},
  canonicalVenueNamesByHandle: {},
  venueResolverSnapshot: {
    venues: [
      {
        id: "venue-first-class",
        instagramHandle: "current_venue_handle",
        name: "Current Venue Name",
      },
    ],
    identities: [
      {
        active: true,
        kind: "historical_alias",
        value: "Former Venue Name",
        venueId: "venue-first-class",
      },
      {
        active: true,
        kind: "provider_account",
        provider: "instagram",
        value: "former_venue_handle",
        venueId: "venue-first-class",
      },
    ],
  },
});
assert.equal(
  resolveIngestionVenue(firstClassIngestionResolver, {
    rawVenueClaim: "Former Venue Name",
    sourceRole: "promoter",
  }).venue,
  "Current Venue Name",
  "Ingestion must consume first-class historical identities absent from legacy venue aliases.",
);
assert.equal(
  resolveIngestionVenue(firstClassIngestionResolver, {
    postingProviderHandle: "former_venue_handle",
    sourceRole: "venue",
  }).venue,
  "Current Venue Name",
  "Ingestion must consume first-class provider-account identities absent from the primary handle.",
);

const legacyPriorityResolver = buildIngestionVenueResolver({
  canonicalVenueNamesByHandle: {
    kcgrad: "KC Grad",
    "unknown.source": "Configured Venue",
    "other.source": "Other Venue",
  },
  configuredVenueNamesByHandle: {
    "unknown.source": "Configured Venue",
  },
});
assert.equal(
  resolveIngestionVenue(legacyPriorityResolver, {
    postingProviderHandle: "unknown.source",
    rawVenueClaim: "Other Venue",
    sourceRole: "unknown",
  }).venue,
  "Configured Venue",
  "First-class resolution must preserve the configured source-map precedence.",
);
assert.equal(
  resolveIngestionVenue(legacyPriorityResolver, {
    evidenceTexts: ["Venue: @kcgrad"],
    postingProviderHandle: "unknown.source",
    rawVenueClaim: "Configured Venue",
    sourceRole: "venue",
  }).venue,
  "KC Grad",
  "Locative immutable handle evidence must preserve its characterized precedence.",
);

const parityCases = [
  {
    label: "canonical name with capitalization",
    input: { rawVenueClaim: "kc GRAD" },
    expected: "KC Grad",
  },
  {
    label: "configured alias with diacritics",
    input: { rawVenueClaim: "Čilton Bašti" },
    expected: "Chillton Bašta",
  },
  {
    label: "historical alias",
    input: { rawVenueClaim: "New Cinema Zvezda" },
    expected: "Novi Bioskop Zvezda",
  },
  {
    label: "Instagram handle claim",
    input: { rawVenueClaim: "@kolarac_art_bioskop" },
    expected: "Art bioskop Kolarac",
  },
  {
    label: "location tag",
    input: { locationName: "Kulturni centar Grad" },
    expected: "KC Grad",
  },
  {
    label: "promoter explicitly names another venue",
    input: {
      evidenceTexts: ["Vidimo se večeras u @kcgrad"],
      postingProviderHandle: "independent_promoter",
      sourceRole: "promoter",
    },
    expected: "KC Grad",
  },
];

for (const fixture of parityCases) {
  const resolution = resolveVenue(snapshot, fixture.input);
  assert.equal(resolution.status, "resolved", `${fixture.label} should resolve`);
  if (resolution.status !== "resolved") continue;
  assert.equal(resolution.venue.name, fixture.expected, fixture.label);

  const legacy = normalizeVenueFromEvidence({
    canonicalVenueAliasesByHandle,
    canonicalVenueNamesByHandle,
    handle: fixture.input.postingProviderHandle ?? "unknown_source",
    immutableEvidenceTexts: fixture.input.evidenceTexts ?? [],
    locationName: fixture.input.locationName,
    rawModelVenue: fixture.input.rawVenueClaim ?? "",
    allowCanonicalHandleFallback: fixture.input.sourceRole !== "promoter",
  });
  assert.equal(
    legacy.venue,
    fixture.expected,
    `${fixture.label} must remain compatible with the characterized ingestion result`,
  );

  const ingestion = resolveIngestionVenue(ingestionResolver, {
    evidenceTexts: fixture.input.evidenceTexts,
    locationName: fixture.input.locationName,
    postingProviderHandle: fixture.input.postingProviderHandle,
    rawVenueClaim: fixture.input.rawVenueClaim,
    sourceRole: fixture.input.sourceRole,
  });
  assert.equal(
    ingestion.venue,
    fixture.expected,
    `${fixture.label} must use the universal ingestion adapter`,
  );
}

const sourceAccountResolution = resolveVenue(snapshot, {
  postingProviderHandle: "@para_klub",
  sourceRole: "venue",
  sourceVenueId: "venue-para",
});
assert.equal(sourceAccountResolution.status, "resolved");
if (sourceAccountResolution.status === "resolved") {
  assert.equal(sourceAccountResolution.venue.name, "Para Klub");
  assert.equal(sourceAccountResolution.reason, "source_account");
}

const unknown = resolveVenue(snapshot, {
  postingProviderHandle: "unknown_promoter",
  rawVenueClaim: "Unconfigured secret address",
  sourceRole: "promoter",
});
assert.equal(unknown.status, "unresolved");
if (unknown.status === "unresolved") {
  assert.equal(unknown.proposedName, "Unconfigured secret address");
}

const ambiguousSnapshot = buildVenueSnapshot({
  venues: [
    { aliases: ["Shared Hall"], id: "venue-a", name: "Venue A" },
    { aliases: ["Shared Hall"], id: "venue-b", name: "Venue B" },
  ],
});
const ambiguous = resolveVenue(ambiguousSnapshot, { rawVenueClaim: "shared hall" });
assert.equal(ambiguous.status, "ambiguous");
assert.deepEqual(
  ambiguous.candidates.map((candidate) => candidate.id),
  ["venue-a", "venue-b"],
  "Ambiguous aliases must expose candidates and fail closed.",
);

const conflictingEvidenceSnapshot = buildVenueSnapshot({
  venues: [
    { aliases: ["Poster Hall"], id: "venue-poster", name: "Poster Venue" },
    { aliases: ["Tagged Place"], id: "venue-location", name: "Location Venue" },
  ],
});
const conflictingEvidence = resolveVenue(conflictingEvidenceSnapshot, {
  locationName: "Tagged Place",
  rawVenueClaim: "Poster Hall",
});
assert.equal(
  conflictingEvidence.status,
  "ambiguous",
  "Independent model/poster and location evidence must fail closed when they disagree.",
);
assert.deepEqual(
  conflictingEvidence.candidates.map((candidate) => candidate.id),
  ["venue-location", "venue-poster"],
);

function makeIndexedResolverDb({ identities, migrationReady = true, venueRows }) {
  const venuesById = new Map(venueRows.map((venue) => [venue._id, venue]));
  const queryCounts = { eventDomainMigrationState: 0, venueIdentities: 0, venues: 0 };
  const migrationRows = migrationReady ? [{
    _id: "venue-identities-migration",
    completedAt: 1,
    errorCount: 0,
    key: "venue-identities-v1",
    mismatchCount: 0,
  }] : [];
  return {
    queryCounts,
    db: {
      async get(id) {
        return venuesById.get(id) ?? null;
      },
      query(table) {
        queryCounts[table] += 1;
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
            const rows = table === "venues"
              ? venueRows
              : table === "eventDomainMigrationState"
                ? migrationRows
                : identities;
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
  };
}

{
  const venueRows = [
    {
      _id: "venue-partial-a",
      aliases: ["Shared Migration Alias"],
      category: "club",
      instagramHandle: "partial_a",
      isActive: true,
      name: "Partial A",
    },
    {
      _id: "venue-partial-b",
      aliases: ["Shared Migration Alias"],
      category: "club",
      instagramHandle: "partial_b",
      isActive: true,
      name: "Partial B",
    },
  ];
  const identityFor = (venue, index) => ({
    _id: `identity-partial-${index}`,
    active: true,
    kind: "alias",
    normalizedValue: "shared migration alias",
    rawValue: "Shared Migration Alias",
    venueId: venue._id,
  });
  const duringMigration = makeIndexedResolverDb({
    identities: [identityFor(venueRows[0], 0)],
    migrationReady: false,
    venueRows,
  });
  assert.equal(
    (await resolveVenueForWrite(
      { db: duringMigration.db },
      "Shared Migration Alias",
    )).resolution.status,
    "ambiguous",
    "A partially migrated identity must not suppress a conflicting legacy venue.",
  );
  const afterMigration = makeIndexedResolverDb({
    identities: venueRows.map(identityFor),
    migrationReady: true,
    venueRows,
  });
  assert.equal(
    (await resolveVenueForWrite(
      { db: afterMigration.db },
      "Shared Migration Alias",
    )).resolution.status,
    "ambiguous",
  );
}

{
  const venue = {
    _id: "venue-indexed",
    aliases: ["Indexed Hall"],
    category: "culture",
    instagramHandle: "indexed_hall",
    isActive: true,
    name: "Indexed Venue",
  };
  const identity = {
    _id: "identity-indexed-alias",
    active: true,
    kind: "alias",
    normalizedValue: "indexed hall",
    rawValue: "Indexed Hall",
    venueId: venue._id,
  };
  const state = makeIndexedResolverDb({ identities: [identity], venueRows: [venue] });
  const resolution = await resolveVenueForWrite({ db: state.db }, "INDEXED HALL");
  assert.equal(resolution.resolution.status, "resolved");
  assert.equal(resolution.canonicalVenueName, "Indexed Venue");
  assert.equal(resolution.lookupMode, "indexed_identity");
  assert.equal(
    state.queryCounts.venues,
    0,
    "An indexed identity hit must not load the entire venue directory.",
  );
}

{
  const venueRows = [
    { _id: "venue-a", aliases: [], isActive: true, name: "Venue A" },
    { _id: "venue-b", aliases: [], isActive: true, name: "Venue B" },
  ];
  const identities = venueRows.map((venue, index) => ({
    _id: `identity-shared-${index}`,
    active: true,
    kind: "historical_alias",
    normalizedValue: "shared indexed hall",
    rawValue: "Shared Indexed Hall",
    venueId: venue._id,
  }));
  const state = makeIndexedResolverDb({ identities, venueRows });
  const resolution = await resolveVenueForWrite(
    { db: state.db },
    "Shared Indexed Hall",
  );
  assert.equal(
    resolution.resolution.status,
    "ambiguous",
    "Conflicting indexed identities must fail closed.",
  );
  assert.equal(state.queryCounts.venues, 0);
}

console.log("Universal venue resolver parity QA passed.");
