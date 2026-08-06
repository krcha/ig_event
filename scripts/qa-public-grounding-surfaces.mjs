import assert from "node:assert/strict";

import { getDiscoverFeed } from "../convex/events.ts";
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
      assert.equal(table, "events");
      return {
        withIndex(index, configure) {
          configure(indexBuilder());
          return {
            async collect() {
              return index === "by_status_promotionTier" ? [ungrounded] : [];
            },
            async take() {
              return index === "by_status_date" ? [ungrounded] : [];
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
