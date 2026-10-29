import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPublicEventPostHandler } from "../lib/events/public-event-post.ts";

const eventId = "j578mw1v72asdhawga974smym989xcjj";
const sourceUrl = "https://www.instagram.com/reel/SourcePost_1/?igsh=test";
const event = {
  _id: eventId,
  status: "approved",
  title: "Analog Night",
  venue: "20/44",
  venueInstagramHandle: "physical.venue",
  sourceCaption: "Original caption\nwith its original line breaks.",
  description: "Generated event description.",
  instagramPostId: "1234567890",
  instagramPostUrl: sourceUrl,
  imageStorageId: "stored-poster",
  serviceSecret: "must-not-leak",
  moderationNote: "private review",
};

function request(id = eventId) {
  return [new Request(`https://eventzeka.test/api/events/${id}/post`), {
    params: Promise.resolve({ eventId: id }),
  }];
}

async function read(response, status) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  return response.json();
}

let sourceCalls = 0;
const fromOriginal = createPublicEventPostHandler({
  loadEvent: async (id) => {
    assert.equal(id, eventId);
    return event;
  },
  loadSourcePost: async () => { sourceCalls++; return null; },
});
assert.deepEqual(await read(await fromOriginal(...request()), 200), {
  eventId,
  title: "Analog Night",
  venue: "20/44",
  instagramHandle: null,
  instagramPostUrl: "https://www.instagram.com/p/SourcePost_1/",
  imageUrl: `/api/discover/images/${eventId}`,
  caption: "Original caption\nwith its original line breaks.",
  captionSource: "instagram",
});
assert.equal(sourceCalls, 0, "Original captions must not trigger another source query.");

let eventCalls = 0;
const invalid = createPublicEventPostHandler({
  loadEvent: async () => { eventCalls++; return event; },
  loadSourcePost: async () => { sourceCalls++; return null; },
});
await read(await invalid(...request("not-an-event-id")), 400);
assert.equal(eventCalls, 0, "Malformed IDs must not reach the backend.");

for (const unavailable of [null, { ...event, status: "pending" }, { ...event, _id: "different" }]) {
  const hidden = createPublicEventPostHandler({
    loadEvent: async () => unavailable,
    loadSourcePost: async () => { throw new Error("Sources of non-public events must not load."); },
  });
  assert.deepEqual(await read(await hidden(...request()), 404), { error: "Event not found." });
}

const transient = createPublicEventPostHandler({
  loadEvent: async () => { throw new Error("internal secret should never reach the response"); },
  loadSourcePost: async () => null,
});
assert.deepEqual(await read(await transient(...request()), 503), {
  error: "Event post is temporarily unavailable.",
});

let refs = [];
const fromRetainedSource = createPublicEventPostHandler({
  loadEvent: async () => ({ ...event, sourceCaption: "   ", imageStorageId: undefined }),
  loadSourcePost: async (ref) => {
    refs.push(ref);
    return {
      caption: "The complete retained Instagram caption.",
      postId: "1234567890",
      instagramPostUrl: "https://www.instagram.com/p/SourcePost_1/",
    };
  },
});
const retained = await read(await fromRetainedSource(...request()), 200);
assert.equal(retained.caption, "The complete retained Instagram caption.");
assert.equal(retained.captionSource, "instagram");
assert.equal(retained.imageUrl, `/api/discover/images/${eventId}`);
assert.deepEqual(refs, [{
  handle: "",
  postId: "1234567890",
  instagramPostUrl: "https://www.instagram.com/p/SourcePost_1/",
}], "Source lookups must contain only the selected public event's exact references.");

for (const sourceResult of [
  null,
  {
    caption: "An unrelated post must never be displayed.",
    postId: "unrelated",
    instagramPostUrl: "https://www.instagram.com/p/OtherPost/",
  },
  {
    caption: "A contradictory source URL must not be paired with this event.",
    postId: event.instagramPostId,
    instagramPostUrl: "https://www.instagram.com/p/OtherPost/",
  },
]) {
  const fallback = createPublicEventPostHandler({
    loadEvent: async () => ({ ...event, sourceCaption: undefined }),
    loadSourcePost: async () => sourceResult,
  });
  const result = await read(await fallback(...request()), 200);
  assert.equal(result.caption, event.description);
  assert.equal(result.captionSource, "event", "Generated descriptions are never original Instagram text.");
}

const sourceFailure = createPublicEventPostHandler({
  loadEvent: async () => ({ ...event, sourceCaption: undefined }),
  loadSourcePost: async () => { throw new Error("Stored source lookup unavailable."); },
});
assert.equal((await read(await sourceFailure(...request()), 200)).captionSource, "event");

let unsafeSourceCalls = 0;
const noSource = createPublicEventPostHandler({
  loadEvent: async () => ({
    ...event,
    sourceCaption: undefined,
    description: undefined,
    imageStorageId: undefined,
    imageUrl: "https://untrusted.example/poster.jpg",
    instagramPostId: undefined,
    instagramPostUrl: "javascript:alert(1)",
  }),
  loadSourcePost: async () => { unsafeSourceCalls++; return null; },
});
const noSourceResult = await read(await noSource(...request()), 200);
assert.equal(noSourceResult.instagramPostUrl, null);
assert.equal(noSourceResult.instagramHandle, null);
assert.equal(noSourceResult.imageUrl, null);
assert.equal(noSourceResult.caption, null);
assert.equal(noSourceResult.captionSource, null);
assert.equal(unsafeSourceCalls, 0);

const route = readFileSync("app/api/events/[eventId]/post/route.ts", "utf8");
assert.match(route, /events:getPublicApprovedEvent/);
assert.match(route, /refs: \[ref\]/);
assert.match(route, /dynamic = "force-dynamic"/);
assert.ok(!route.includes("serviceSecret") && !route.includes("setAdminAuth"));

console.log("Public event post QA passed: selected-event eligibility, original-caption precedence, bounded retained-source fallback, safe links/media, truthful fallback labels and no-store failures.");
