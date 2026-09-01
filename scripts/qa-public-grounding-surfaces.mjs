import assert from "node:assert/strict";

import { getDiscoverFeed, getPublicApprovedEvent } from "../convex/events.ts";
import { getPublicEventImageSource } from "../convex/mediaAssets.ts";
import { getPublicVenuePage } from "../convex/venues.ts";

const venue = {
  _id: "venue-public-grounding",
  _creationTime: 1,
  name: "Grounding Venue",
  instagramHandle: "grounding_venue",
  normalizedInstagramHandle: "grounding_venue",
  category: "club",
  isActive: true,
  publicStatus: "published",
  scrapeActive: true,
  createdAt: 1,
  updatedAt: 1,
};
const ungrounded = {
  _id: "event-ungrounded-approved",
  _creationTime: 1,
  title: "Ungrounded approved event",
  date: "2026-08-07",
  time: "20:00",
  venue: venue.name,
  venueId: venue._id,
  venueInstagramHandle: venue.instagramHandle,
  normalizedVenueInstagramHandle: venue.normalizedInstagramHandle,
  normalizedVenueIdentity: "grounding venue",
  artists: [],
  eventType: "music",
  imageUrl: "https://example.com/ungrounded.jpg",
  imageStorageId: "storage-ungrounded",
  status: "approved",
  promotionTier: "featured",
  promotionStart: "2026-08-01",
  promotionEnd: "2026-08-31",
  createdAt: 1,
  updatedAt: 1,
};

const legacyDetailCtx = {
  db: {
    normalizeId(table, id) {
      return table === "events" && id === ungrounded._id ? id : null;
    },
    async get(id) {
      if (id === ungrounded._id) return ungrounded;
      if (id === venue._id) return venue;
      return null;
    },
    query() {
      throw new Error("Legacy detail compatibility must not require grounding reads.");
    },
  },
};
const legacyDetail = await getPublicApprovedEvent._handler(legacyDetailCtx, {
  id: ungrounded._id,
});
assert.equal(
  legacyDetail?._id,
  ungrounded._id,
  "An approved legacy event exposed by the public calendar must retain a working detail page.",
);

const materializedPendingLegacy = {
  ...ungrounded,
  _id: "event-materialized-pending",
  publicationPolicyVersion: 1,
  publicationReason: "derived_state_refresh_deferred",
  publicationState: "pending_verification",
};
const materializedPendingCtx = {
  db: {
    normalizeId(table, id) {
      return table === "events" && id === materializedPendingLegacy._id ? id : null;
    },
    async get(id) {
      return id === materializedPendingLegacy._id ? materializedPendingLegacy : null;
    },
    query() {
      throw new Error("A non-publishable materialized row must fail before grounding reads.");
    },
  },
};
assert.equal(
  await getPublicApprovedEvent._handler(materializedPendingCtx, {
    id: materializedPendingLegacy._id,
  }),
  null,
  "Approved status must not bypass a current pending publication decision.",
);

const ungroundedEvidenceV2 = {
  ...ungrounded,
  _id: "event-ungrounded-evidence-v2",
  normalizedFieldsJson: JSON.stringify({ extractionContractVersion: "event_evidence_v2" }),
};
const evidenceV2DetailCtx = {
  db: {
    normalizeId(table, id) {
      return table === "events" && id === ungroundedEvidenceV2._id ? id : null;
    },
    async get(id) {
      return id === ungroundedEvidenceV2._id ? ungroundedEvidenceV2 : null;
    },
    query() {
      throw new Error("Incomplete evidence-v2 detail must fail before canonical source reads.");
    },
  },
};
assert.equal(
  await getPublicApprovedEvent._handler(evidenceV2DetailCtx, {
    id: ungroundedEvidenceV2._id,
  }),
  null,
  "An ungrounded evidence-v2 event detail must remain hidden.",
);

function indexBuilder() {
  const builder = {
    eq() {
      return builder;
    },
    gte() {
      return builder;
    },
    lte() {
      return builder;
    },
    lt() {
      return builder;
    },
  };
  return builder;
}

const venueCtx = {
  db: {
    normalizeId(table, id) {
      return table === "venues" && id === venue._id ? id : null;
    },
    async get(id) {
      return id === venue._id ? venue : null;
    },
    query(table) {
      assert.equal(table, "events");
      return {
        withIndex(index, configure) {
          configure(indexBuilder());
          const chain = {
            order() {
              return chain;
            },
            async take() {
              return index === "by_venueId_status_date" ? [ungrounded] : [];
            },
          };
          return chain;
        },
      };
    },
  },
};
const venuePage = await getPublicVenuePage._handler(venueCtx, {
  id: venue._id,
  today: "2026-08-06",
  upcomingLimit: 12,
  historyLimit: 12,
});
assert.deepEqual(venuePage.upcomingEvents, []);
assert.deepEqual(venuePage.historyEvents, []);

const discoverCtx = {
  db: {
    async get() {
      return null;
    },
    query(table) {
      if (
        table === "publicationMigrationState" ||
        table === "sourceOccurrenceTopologyEpoch"
      ) {
        return {
          withIndex(_index, configure) {
            configure(indexBuilder());
            return { async take() { return []; } };
          },
        };
      }
      assert.equal(table, "events");
      return {
        withIndex(index, configure) {
          configure(indexBuilder());
          return {
            async collect() {
              return index === "by_status_promotionTier"
                ? [materializedPendingLegacy]
                : [];
            },
            async take() {
              return index === "by_status_date" ? [materializedPendingLegacy] : [];
            },
          };
        },
      };
    },
  },
};
const discover = await getDiscoverFeed._handler(discoverCtx, { today: "2026-08-06" });
for (const group of Object.values(discover)) {
  assert.deepEqual(group, []);
}

let storageRead = false;
const mediaCtx = {
  db: {
    normalizeId(table, id) {
      return table === "events" && id === ungrounded._id ? id : null;
    },
    async get(id) {
      return id === ungrounded._id ? ungrounded : null;
    },
  },
  storage: {
    async getUrl() {
      storageRead = true;
      return "https://storage.example.com/ungrounded.jpg";
    },
  },
};
assert.deepEqual(
  await getPublicEventImageSource._handler(mediaCtx, { eventId: ungrounded._id }),
  { eventExists: false, kind: "none" },
);
assert.equal(storageRead, false, "Ungrounded image sources must fail before storage access.");

console.log("Public grounding surface QA passed: venue, discover, and media reads fail closed.");
