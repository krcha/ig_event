import assert from "node:assert/strict";
import { assertSourceAccountVenueFallbackPolicy } from "../convex/eventDomain/sourceAccountVenueFallback.ts";

const venue = {
  _id: "venue-account-hall",
  name: "Account Hall",
  instagramHandle: "account_hall",
  category: "culture",
  publicStatus: "published",
  scrapeActive: true,
};
const otherVenue = {
  ...venue,
  _id: "venue-other-hall",
  name: "Other Hall",
  instagramHandle: "other_hall",
};
const source = {
  _id: "source-account-hall",
  handle: venue.instagramHandle,
  role: "venue",
  venueId: venue._id,
  active: true,
};
const raw = {
  extraction_contract_version: "event_evidence_v2",
  is_event: true,
  venue: "",
  source_conflicts: [],
  shared_schedule_context: {
    venue: { applies_to_all: false, value: "" },
  },
  schedule_entries: [],
};
const fields = {
  venueAccountFallbackVersion: 1,
  sourceAccountRole: "venue",
  trustedVenueSource: true,
  venueSource: "handle_map",
  sourceGroundingInstagramHandle: venue.instagramHandle,
  sourceGroundingInstagramPostId: "ACCOUNTPOST1",
  sourceGroundingInstagramPostUrl: "https://www.instagram.com/p/ACCOUNTPOST1/",
  normalizedVenue: venue.name,
  rawVenue: "",
};

function identityRows(venueRow) {
  return [
    {
      _id: `${venueRow._id}-name`,
      active: true,
      kind: "canonical_name",
      rawValue: venueRow.name,
      normalizedValue: venueRow.name.toLowerCase(),
      venueId: venueRow._id,
    },
    {
      _id: `${venueRow._id}-account`,
      active: true,
      kind: "provider_account",
      provider: "instagram",
      rawValue: venueRow.instagramHandle,
      normalizedValue: venueRow.instagramHandle,
      venueId: venueRow._id,
    },
  ];
}

function fixture(options = {}) {
  const selectedFields = { ...fields, ...options.fields };
  const selectedRaw = { ...raw, ...options.raw };
  const candidate = {
    venue: venue.name,
    venueId: venue._id,
    venueInstagramHandle: venue.instagramHandle,
    instagramPostId: fields.sourceGroundingInstagramPostId,
    instagramPostUrl: fields.sourceGroundingInstagramPostUrl,
    normalizedFieldsJson: JSON.stringify(selectedFields),
    rawExtractionJson: JSON.stringify(selectedRaw),
    ...options.candidate,
  };
  const persistedPost = {
    _id: "saved-account-post",
    handle: venue.instagramHandle,
    username: venue.instagramHandle,
    postId: candidate.instagramPostId,
    instagramPostUrl: candidate.instagramPostUrl,
    analysisResultJson: candidate.rawExtractionJson,
    ...options.post,
  };
  const venueRows = options.venueRows ?? [venue, otherVenue];
  const tables = {
    instagramSources: options.sources ?? [source],
    venues: venueRows,
    venueIdentities: options.identities ?? venueRows.flatMap(identityRows),
    eventDomainMigrationState: [{
      _id: "migration-venue-identities",
      key: "venue-identities-v1",
      completedAt: 1,
      mismatchCount: 0,
      errorCount: 0,
    }],
  };
  const queries = [];
  const ctx = {
    db: {
      async get(id) {
        return venueRows.find((row) => row._id === id) ?? null;
      },
      query(table) {
        assert.ok(Object.hasOwn(tables, table), `Unexpected table ${table}`);
        assert.notEqual(table, "venues", "Fallback must use indexed identities, not load the venue directory.");
        const criteria = {};
        let index;
        const chain = {
          withIndex(indexName, configure) {
            index = indexName;
            const builder = {
              eq(field, value) {
                criteria[field] = value;
                return builder;
              },
            };
            configure(builder);
            return chain;
          },
          async take(limit) {
            assert.ok(index, "Every fallback read must use an index.");
            assert.ok(limit <= 9, "Every fallback identity read must remain bounded.");
            queries.push({ table, index, limit });
            return tables[table].filter((row) => Object.entries(criteria)
              .every(([key, value]) => row[key] === value)).slice(0, limit);
          },
        };
        return chain;
      },
    },
  };
  return { candidate, ctx, persistedPost, queries };
}

async function accepts(label, options = {}) {
  const input = fixture(options);
  const before = structuredClone({ candidate: input.candidate, post: input.persistedPost });
  await assert.doesNotReject(
    assertSourceAccountVenueFallbackPolicy(input.ctx, input.candidate, input.persistedPost),
    label,
  );
  assert.deepEqual({ candidate: input.candidate, post: input.persistedPost }, before,
    "Account fallback verification must not alter saved extraction or public fields.");
  return input;
}

async function rejects(label, options) {
  const input = fixture(options);
  await assert.rejects(
    assertSourceAccountVenueFallbackPolicy(input.ctx, input.candidate, input.persistedPost),
    /Venue account fallback/u,
    label,
  );
}

const exact = await accepts("An active known account can bind its exact public venue when no venue is stated.");
assert.ok(exact.queries.some((query) => query.table === "instagramSources" && query.limit === 2));
await accepts("The same account venue stated explicitly remains compatible with account fallback.", {
  fields: { rawVenue: venue.name },
  raw: { venue: venue.name },
});
await accepts("An exact catalog alias may describe the same venue without changing the extracted claim.", {
  fields: { rawVenue: "Account Room" },
  raw: { venue: "Account Room" },
  identities: [
    ...[venue, otherVenue].flatMap(identityRows),
    { _id: "account-room-alias", active: true, kind: "alias", rawValue: "Account Room",
      normalizedValue: "account room", venueId: venue._id },
  ],
});
await accepts("The selected schedule row may be unlocated while another row names another venue.", {
  fields: { rowSourceText: "Friday concert" },
  raw: { schedule_entries: [
    { source_text: "Friday concert", venue: "" },
    { source_text: "Saturday concert", venue: otherVenue.name },
  ] },
});
const coalescedRows = [
  { source_text: "20:00 First DJ", venue: "" },
  { source_text: "21:00 Second DJ", venue: venue.name },
];
const coalescedFields = {
  rowSourceText: "20:00-22:00\n20:00 First DJ\n21:00 Second DJ",
  lineupScheduleCoalesced: true,
  lineupScheduleCoalescingPolicyVersion: 2,
  lineupScheduleSourceRowCount: 2,
  lineupScheduleSourceEvidence: coalescedRows.map((row) => ({ text: row.source_text, source: "poster" })),
};
await accepts("A coalesced lineup may bind every exact saved row quote to the known account venue.", {
  fields: coalescedFields,
  raw: { schedule_entries: coalescedRows },
});
await rejects("Every coalesced child's explicit venue must retain priority over the posting account.", {
  fields: coalescedFields,
  raw: { schedule_entries: [coalescedRows[0], { ...coalescedRows[1], venue: otherVenue.name }] },
});
await rejects("Coalesced lineup evidence cannot borrow an unattested row quote.", {
  fields: { ...coalescedFields, lineupScheduleSourceEvidence: [
    coalescedFields.lineupScheduleSourceEvidence[0], { text: "Unattested Third DJ", source: "poster" },
  ] },
  raw: { schedule_entries: coalescedRows },
});
await rejects("Coalesced evidence must contain exactly the declared number of source rows.", {
  fields: { ...coalescedFields, lineupScheduleSourceRowCount: 3 },
  raw: { schedule_entries: coalescedRows },
});
await rejects("An unsupported coalescing attestation cannot broaden account fallback.", {
  fields: { ...coalescedFields, lineupScheduleCoalescingPolicyVersion: 1 },
  raw: { schedule_entries: coalescedRows },
});

for (const role of ["promoter", "unknown"]) {
  await rejects(`${role} source provenance cannot claim venue fallback.`, { fields: { sourceAccountRole: role } });
  await rejects(`The current ${role} account cannot borrow a client venue attestation.`, {
    sources: [{ ...source, role }],
  });
}
await rejects("Inactive accounts must stay unbound.", { sources: [{ ...source, active: false }] });
await rejects("An account without a canonical venue ID must stay unbound.", { sources: [{ ...source, venueId: undefined }] });
await rejects("Duplicate account records must not choose one venue arbitrarily.", {
  sources: [source, { ...source, _id: "second-source-record" }],
});
await rejects("A stale source mapping cannot bind another venue.", {
  sources: [{ ...source, venueId: otherVenue._id }],
});
for (const publicStatus of ["hidden", "pending"]) {
  await rejects(`${publicStatus} venues cannot become public through account fallback.`, {
    venueRows: [{ ...venue, publicStatus }, otherVenue],
  });
}
await rejects("Conflicting provider identities cannot use the account fallback.", {
  identities: [
    ...[venue, otherVenue].flatMap(identityRows),
    { _id: "conflicting-account", active: true, kind: "provider_account", provider: "instagram",
      rawValue: venue.instagramHandle, normalizedValue: venue.instagramHandle, venueId: otherVenue._id },
  ],
});
await rejects("A historical account cannot impersonate the current canonical venue account.", {
  venueRows: [{ ...venue, instagramHandle: "current_account_hall" }, otherVenue],
});
for (const candidate of [
  { venue: otherVenue.name },
  { venueId: otherVenue._id },
  { venueInstagramHandle: otherVenue.instagramHandle },
]) {
  await rejects("The public event must bind the exact mapped venue.", { candidate });
}
await rejects("The normalized evidence must bind the same final public venue.", {
  fields: { normalizedVenue: otherVenue.name },
});
for (const otherClaim of [otherVenue.name, "Unregistered Offsite Venue"]) {
  await rejects("A different or unresolved explicit raw venue must be retained rather than replaced.", {
    raw: { venue: otherClaim },
  });
  await rejects("A different or unresolved explicit normalized raw claim cannot be replaced.", {
    fields: { rawVenue: otherClaim },
  });
  await rejects("A shared schedule venue cannot be replaced by the posting account.", {
    raw: { shared_schedule_context: { venue: { applies_to_all: true, value: otherClaim } } },
  });
  await rejects("The selected child's explicitly named venue cannot be replaced.", {
    fields: { rowSourceText: "Friday concert" },
    raw: { schedule_entries: [{ source_text: "Friday concert", venue: otherClaim }] },
  });
}
await rejects("A missing exact row binding cannot borrow the account location for a multi-venue schedule.", {
  fields: { rowSourceText: "Nonexistent schedule row" },
  raw: { schedule_entries: [{ source_text: "Friday concert", venue: "" }] },
});
for (const marker of [null, 0, 2, "1"]) {
  await rejects("Malformed or unsupported account fallback versions must fail closed.", {
    fields: { venueAccountFallbackVersion: marker },
  });
}
for (const post of [
  { handle: "other_account" },
  { username: "other_account" },
  { postId: "DIFFERENTPOST" },
  { instagramPostUrl: "https://www.instagram.com/p/DIFFERENTPOST/" },
  { analysisResultJson: "stale extraction" },
]) {
  await rejects("Fallback must retain the current exact saved post identity and extraction.", { post });
}
await rejects("Account fallback cannot spoof the source post attestation.", {
  fields: { sourceGroundingInstagramPostUrl: "https://www.instagram.com/p/DIFFERENTPOST/" },
});
for (const overrides of [{ trustedVenueSource: false }, { venueSource: "model" }]) {
  await rejects("The inference must be recorded as trusted account provenance.", { fields: overrides });
}

const unmarked = { ...fields };
delete unmarked.venueAccountFallbackVersion;
const legacy = await accepts("Existing unmarked source evidence retains its original approval policy.", {
  candidate: { normalizedFieldsJson: JSON.stringify(unmarked) },
  sources: [],
  venueRows: [],
});
assert.equal(legacy.queries.length, 0, "Unmarked evidence must not introduce catalog reads or policy changes.");

console.log("Account venue fallback integrity QA passed.");
