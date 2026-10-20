import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { getPublicVenueResolverSnapshot } from "../convex/venueResolver.ts";
import {
  buildLegacyOperationalVenueRecords,
  loadOperationalVenueResolverSnapshot,
} from "../lib/pipeline/operational-venues.ts";
import { readIngestionArchitectureSource } from "./qa-support/ingestion-architecture-source.mjs";

process.env.CRON_SECRET = "qa-service-secret";
process.env.ADMIN_CLERK_USER_IDS = "qa-admin";

function venue(id, overrides = {}) {
  return {
    _id: id,
    _creationTime: 1,
    name: `Venue ${id}`,
    instagramHandle: `handle_${id}`,
    aliases: [],
    category: "club",
    publicStatus: "published",
    scrapeActive: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function identity(id, venueId, kind, rawValue, overrides = {}) {
  return {
    _id: id,
    _creationTime: 1,
    venueId,
    kind,
    rawValue,
    normalizedValue: rawValue.toLocaleLowerCase(),
    active: true,
    source: "manual",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function makeCtx({ venues, identities, subject = null }) {
  const reads = [];
  return {
    reads,
    ctx: {
      auth: {
        async getUserIdentity() {
          return subject ? { subject } : null;
        },
      },
      db: {
        query(table) {
          if (table === "venues") {
            return {
              async take(limit) {
                reads.push({ table, kind: "take", limit });
                return venues.slice(0, limit).map((row) => structuredClone(row));
              },
            };
          }
          assert.equal(table, "venueIdentities");
          return {
            withIndex(indexName, configure) {
              assert.equal(indexName, "by_active_kind");
              const filters = {};
              const q = {
                eq(field, value) {
                  filters[field] = value;
                  return q;
                },
              };
              configure(q);
              return {
                async take(limit) {
                  reads.push({ table, kind: "indexedTake", filters, limit });
                  return identities
                    .filter((row) =>
                      Object.entries(filters).every(([key, value]) => row[key] === value),
                    )
                    .slice(0, limit)
                    .map((row) => structuredClone(row));
                },
              };
            },
          };
        },
      },
    },
  };
}

const publicVenue = venue("venue-public", {
  name: "Current Museum",
  instagramHandle: "current_museum",
  aliases: ["Museum Alias"],
  location: "Museum Street 1",
});
const hiddenVenue = venue("venue-hidden", { publicStatus: "hidden" });
const fixture = makeCtx({
  venues: [publicVenue, hiddenVenue],
  identities: [
    identity("identity-history", publicVenue._id, "historical_alias", "Former Museum"),
    identity("identity-provider", publicVenue._id, "provider_account", "former_museum", {
      provider: "instagram",
    }),
    identity("identity-inactive", publicVenue._id, "alias", "Inactive Alias", {
      active: false,
    }),
    identity("identity-hidden", hiddenVenue._id, "alias", "Hidden Alias"),
  ],
});

await assert.rejects(
  getPublicVenueResolverSnapshot._handler(fixture.ctx, {}),
  /authentication|admin/iu,
);
assert.equal(fixture.reads.length, 0, "Authentication must precede every snapshot read.");

const result = await getPublicVenueResolverSnapshot._handler(fixture.ctx, {
  serviceSecret: "qa-service-secret",
});
assert.equal(result.schemaVersion, "venue-resolver-snapshot-v1");
assert.deepEqual(result.venues.map((row) => row.id), [publicVenue._id]);
assert.deepEqual(
  result.identities.map((row) => row.value).sort(),
  ["Former Museum", "former_museum"],
  "Only active identities belonging to public venues may cross the ingestion boundary.",
);
assert.ok(result.fingerprint.startsWith("venue-snapshot-v1:"));
assert.ok(
  fixture.reads[0].limit === 4_001 &&
    fixture.reads.slice(1).every((read, index, reads) =>
      read.limit <= (index === 0 ? 3_999 : reads[index - 1].limit),
    ),
  "Identity partitions must share the aggregate budget left after venue rows.",
);

const legacyRecords = buildLegacyOperationalVenueRecords(result);
assert.deepEqual(
  legacyRecords.map((row) => row.instagramHandle).sort(),
  ["current_museum", "former_museum"],
  "Provider-account identities must remain visible to legacy handle-map consumers.",
);
assert.ok(
  legacyRecords.every((row) => row.aliases.includes("Former Museum")),
  "Historical identities must remain visible to legacy alias-map consumers.",
);

let requestedFunction = null;
let requestedArgs = null;
const loaded = await loadOperationalVenueResolverSnapshot({
  client: {
    async query(functionReference, args) {
      requestedFunction = functionReference;
      requestedArgs = args;
      return result;
    },
  },
  serviceSecret: "qa-service-secret",
});
assert.equal(requestedFunction, "venueResolver:getPublicVenueResolverSnapshot");
assert.deepEqual(requestedArgs, { serviceSecret: "qa-service-secret" });
assert.deepEqual(loaded, result);

const venueOverflow = makeCtx({
  venues: Array.from({ length: 4_001 }, (_, index) => venue(`overflow-${index}`)),
  identities: [],
});
await assert.rejects(
  getPublicVenueResolverSnapshot._handler(venueOverflow.ctx, {
    serviceSecret: "qa-service-secret",
  }),
  /bounded load/iu,
  "A partial venue directory must fail closed.",
);

const identityOverflow = makeCtx({
  venues: [publicVenue],
  identities: Array.from({ length: 4_001 }, (_, index) =>
    identity(`overflow-identity-${index}`, publicVenue._id, "alias", `Alias ${index}`),
  ),
});
await assert.rejects(
  getPublicVenueResolverSnapshot._handler(identityOverflow.ctx, {
    serviceSecret: "qa-service-secret",
  }),
  /bounded load/iu,
  "A partial identity directory must fail closed.",
);

const aggregateIdentityOverflow = makeCtx({
  venues: [publicVenue],
  identities: [
    ...Array.from({ length: 1_000 }, (_, index) =>
      identity(`canonical-${index}`, publicVenue._id, "canonical_name", `Canonical ${index}`),
    ),
    ...Array.from({ length: 1_000 }, (_, index) =>
      identity(`alias-${index}`, publicVenue._id, "alias", `Alias ${index}`),
    ),
    ...Array.from({ length: 1_000 }, (_, index) =>
      identity(`history-${index}`, publicVenue._id, "historical_alias", `History ${index}`),
    ),
    ...Array.from({ length: 1_000 }, (_, index) =>
      identity(`provider-${index}`, publicVenue._id, "provider_account", `Provider ${index}`),
    ),
  ],
});
await assert.rejects(
  getPublicVenueResolverSnapshot._handler(aggregateIdentityOverflow.ctx, {
    serviceSecret: "qa-service-secret",
  }),
  /bounded load/iu,
  "Identity kinds must share one aggregate response/read budget.",
);
assert.deepEqual(
  aggregateIdentityOverflow.reads
    .filter((read) => read.table === "venueIdentities")
    .map((read) => read.limit),
  [4_000, 3_000, 2_000, 1_000],
  "Each identity partition must receive only the remaining aggregate budget plus one sentinel.",
);

const convexSource = readFileSync("convex/venueResolver.ts", "utf8");
const ingestionSource = readIngestionArchitectureSource();
assert.match(convexSource, /export const getPublicVenueResolverSnapshot = query\(\{/);
assert.match(convexSource, /await requireAdminOrServiceSecret\(ctx, args\.serviceSecret\)/);
assert.doesNotMatch(convexSource, /query\("venueIdentities"\)[\s\S]{0,300}\.collect\(\)/);
assert.match(ingestionSource, /loadOperationalVenueResolverSnapshot/);
assert.match(ingestionSource, /venueResolverSnapshot: options\.venueResolverSnapshot/);

console.log("Venue resolver snapshot QA passed.");
