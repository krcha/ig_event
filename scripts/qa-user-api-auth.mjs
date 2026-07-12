import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { preflightUserApiAccess } from "../lib/auth/user-api.ts";
import { createLibraryRouteHandlers } from "../app/api/user/library/handler.ts";
import { createSavedEventRouteHandlers } from "../app/api/user/saved-events/handler.ts";
import { createFavoriteVenueRouteHandlers } from "../app/api/user/favorite-venues/handler.ts";

const signedInUserId = "user_test_123";
const eventId = "event_123";
const venueId = "venue_123";

const pureHandlerPaths = [
  "app/api/user/library/handler.ts",
  "app/api/user/saved-events/handler.ts",
  "app/api/user/favorite-venues/handler.ts",
];
const routePaths = [
  "app/api/user/library/route.ts",
  "app/api/user/saved-events/route.ts",
  "app/api/user/favorite-venues/route.ts",
];

for (const handlerPath of pureHandlerPaths) {
  const source = readFileSync(handlerPath, "utf8");
  for (const serverOnlyImport of [
    '"server-only"',
    '"@clerk/nextjs/server"',
    '"@/lib/auth/user-api-server"',
    '"@/lib/convex/server"',
  ]) {
    assert.ok(
      !source.includes(serverOnlyImport),
      `${handlerPath} must remain injectable and must not import ${serverOnlyImport}.`,
    );
  }
}

for (const routePath of routePaths) {
  const source = readFileSync(routePath, "utf8");
  assert.match(source, /create[A-Za-z]+RouteHandlers\(\{/);
  assert.ok(source.includes('"@/lib/auth/user-api-server"'));
  assert.ok(source.includes('"@/lib/convex/server"'));
}

assert.ok(
  readFileSync("lib/auth/user-api-server.ts", "utf8").startsWith('import "server-only";'),
  "The Clerk-backed user API guard must be explicitly server-only.",
);

function configuredAccess(userId = signedInUserId) {
  return () =>
    preflightUserApiAccess({
      authConfigured: true,
      getUserId: async () => userId,
    });
}

function unconfiguredAccess(onAuth = () => {}) {
  return () =>
    preflightUserApiAccess({
      authConfigured: false,
      getUserId: async () => {
        onAuth();
        return signedInUserId;
      },
    });
}

async function expectJson(response, status, body) {
  assert.equal(response.status, status);
  assert.match(response.headers.get("content-type") ?? "", /^application\/json\b/i);
  assert.deepEqual(await response.json(), body);
}

function postRequest(body) {
  return new Request("http://localhost/api/user/test", {
    body,
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

function postJson(body) {
  return postRequest(JSON.stringify(body));
}

const routeCases = [
  {
    label: "library GET",
    makeHandlers(requireAccess, onDataClient) {
      return createLibraryRouteHandlers({
        createDataClient: async () => {
          onDataClient();
          return { getLibrary: async () => ({}) };
        },
        requireAccess,
      });
    },
    run: (handlers) => handlers.GET(),
  },
  {
    label: "saved-events GET",
    makeHandlers(requireAccess, onDataClient) {
      return createSavedEventRouteHandlers({
        createDataClient: async () => {
          onDataClient();
          return {
            getEvent: async () => null,
            getLibrary: async () => ({}),
            toggleSavedEvent: async () => ({ saved: false }),
          };
        },
        requireAccess,
      });
    },
    run: (handlers) => handlers.GET(),
  },
  {
    label: "saved-events POST",
    makeHandlers(requireAccess, onDataClient) {
      return createSavedEventRouteHandlers({
        createDataClient: async () => {
          onDataClient();
          return {
            getEvent: async () => null,
            getLibrary: async () => ({}),
            toggleSavedEvent: async () => ({ saved: false }),
          };
        },
        requireAccess,
      });
    },
    run: (handlers) => handlers.POST(postRequest("not valid json")),
    runDependency: (handlers) =>
      handlers.POST(postJson({ eventId, saved: true })),
  },
  {
    label: "favorite-venues GET",
    makeHandlers(requireAccess, onDataClient) {
      return createFavoriteVenueRouteHandlers({
        createDataClient: async () => {
          onDataClient();
          return {
            getLibrary: async () => ({}),
            getVenues: async () => [],
            toggleFavoriteVenue: async () => ({ favorite: false }),
          };
        },
        requireAccess,
      });
    },
    run: (handlers) => handlers.GET(),
  },
  {
    label: "favorite-venues POST",
    makeHandlers(requireAccess, onDataClient) {
      return createFavoriteVenueRouteHandlers({
        createDataClient: async () => {
          onDataClient();
          return {
            getLibrary: async () => ({}),
            getVenues: async () => [],
            toggleFavoriteVenue: async () => ({ favorite: false }),
          };
        },
        requireAccess,
      });
    },
    run: (handlers) => handlers.POST(postRequest("not valid json")),
    runDependency: (handlers) =>
      handlers.POST(postJson({ favorite: true, venueId })),
  },
];

for (const routeCase of routeCases) {
  let dataClientCalls = 0;
  const signedOutHandlers = routeCase.makeHandlers(
    configuredAccess(null),
    () => dataClientCalls++,
  );
  await expectJson(await routeCase.run(signedOutHandlers), 401, {
    error: "Unauthorized",
  });
  assert.equal(
    dataClientCalls,
    0,
    `${routeCase.label} must not create an authenticated data client when signed out.`,
  );

  let authCalls = 0;
  const unconfiguredHandlers = routeCase.makeHandlers(
    unconfiguredAccess(() => authCalls++),
    () => dataClientCalls++,
  );
  await expectJson(await routeCase.run(unconfiguredHandlers), 503, {
    error: "Authentication is not configured.",
  });
  assert.equal(authCalls, 0, `${routeCase.label} must not call Clerk when auth is unconfigured.`);
  assert.equal(
    dataClientCalls,
    0,
    `${routeCase.label} must not create an authenticated data client when auth is unconfigured.`,
  );
}

{
  let dataClientCalls = 0;
  const handlers = createSavedEventRouteHandlers({
    createDataClient: async () => {
      dataClientCalls++;
      throw new Error("must not be called");
    },
    requireAccess: configuredAccess(),
  });
  await expectJson(await handlers.POST(postRequest("not valid json")), 400, {
    error: "Invalid JSON body.",
  });
  await expectJson(await handlers.POST(postRequest("null")), 400, {
    error: "A valid eventId is required.",
  });
  assert.equal(dataClientCalls, 0, "Malformed saved-event input must not call Convex.");
}

{
  let dataClientCalls = 0;
  const handlers = createFavoriteVenueRouteHandlers({
    createDataClient: async () => {
      dataClientCalls++;
      throw new Error("must not be called");
    },
    requireAccess: configuredAccess(),
  });
  await expectJson(await handlers.POST(postRequest("not valid json")), 400, {
    error: "Invalid JSON body.",
  });
  await expectJson(await handlers.POST(postRequest("{}")), 400, {
    error: "A valid venueId is required.",
  });
  assert.equal(dataClientCalls, 0, "Malformed favorite-venue input must not call Convex.");
}

const library = {
  favoriteVenueIds: [venueId],
  favoriteVenues: [{ _id: venueId, name: "Test Venue" }],
  savedEventIds: [eventId],
  savedEvents: [{ _id: eventId, title: "Test Event" }],
  userId: signedInUserId,
};

{
  const handlers = createLibraryRouteHandlers({
    createDataClient: async () => ({ getLibrary: async () => library }),
    requireAccess: configuredAccess(),
  });
  await expectJson(await handlers.GET(), 200, library);
}

{
  const handlers = createSavedEventRouteHandlers({
    createDataClient: async () => ({
      getEvent: async (id) => ({ _id: id, title: "Test Event" }),
      getLibrary: async () => library,
      toggleSavedEvent: async (id, saved) => ({ eventId: id, saved }),
    }),
    requireAccess: configuredAccess(),
  });
  await expectJson(await handlers.GET(), 200, library);
  await expectJson(
    await handlers.POST(postJson({ eventId, saved: true })),
    200,
    {
      event: { _id: eventId, title: "Test Event" },
      eventId,
      saved: true,
      userId: signedInUserId,
    },
  );
}

{
  const handlers = createFavoriteVenueRouteHandlers({
    createDataClient: async () => ({
      getLibrary: async () => library,
      getVenues: async (ids) => ids.map((id) => ({ _id: id, name: "Test Venue" })),
      toggleFavoriteVenue: async (id, favorite) => ({ favorite, venueId: id }),
    }),
    requireAccess: configuredAccess(),
  });
  await expectJson(await handlers.GET(), 200, library);
  await expectJson(
    await handlers.POST(postJson({ favorite: true, venueId })),
    200,
    {
      favorite: true,
      userId: signedInUserId,
      venue: { _id: venueId, name: "Test Venue" },
      venueId,
    },
  );
}

{
  let receivedSaved = true;
  const handlers = createSavedEventRouteHandlers({
    createDataClient: async () => ({
      getEvent: async () => {
        throw new Error("getEvent must not run when the event is unsaved");
      },
      getLibrary: async () => library,
      toggleSavedEvent: async (id, saved) => {
        receivedSaved = saved;
        return { eventId: id, saved: false };
      },
    }),
    requireAccess: configuredAccess(),
  });
  await expectJson(await handlers.POST(postJson({ eventId })), 200, {
    event: null,
    eventId,
    saved: false,
    userId: signedInUserId,
  });
  assert.equal(receivedSaved, undefined, "Omitting saved must preserve toggle semantics.");
}

{
  let receivedFavorite = true;
  const handlers = createFavoriteVenueRouteHandlers({
    createDataClient: async () => ({
      getLibrary: async () => library,
      getVenues: async () => {
        throw new Error("getVenues must not run when the venue is unfavorited");
      },
      toggleFavoriteVenue: async (id, favorite) => {
        receivedFavorite = favorite;
        return { favorite: false, venueId: id };
      },
    }),
    requireAccess: configuredAccess(),
  });
  await expectJson(await handlers.POST(postJson({ venueId })), 200, {
    favorite: false,
    userId: signedInUserId,
    venue: null,
    venueId,
  });
  assert.equal(
    receivedFavorite,
    undefined,
    "Omitting favorite must preserve toggle semantics.",
  );
}

{
  const handlers = createSavedEventRouteHandlers({
    createDataClient: async () => ({
      getEvent: async () => null,
      getLibrary: async () => library,
      toggleSavedEvent: async () => {
        throw new Error("Approved event not found. secret provider detail");
      },
    }),
    requireAccess: configuredAccess(),
  });
  await expectJson(
    await handlers.POST(postJson({ eventId, saved: true })),
    404,
    { error: "Approved event not found." },
  );
}

{
  const handlers = createFavoriteVenueRouteHandlers({
    createDataClient: async () => ({
      getLibrary: async () => library,
      getVenues: async () => [],
      toggleFavoriteVenue: async () => {
        throw new Error("Venue not found. secret provider detail");
      },
    }),
    requireAccess: configuredAccess(),
  });
  await expectJson(
    await handlers.POST(postJson({ favorite: true, venueId })),
    404,
    { error: "Venue not found." },
  );
}

for (const routeCase of routeCases) {
  const handlers = routeCase.makeHandlers(configuredAccess(), () => {
    throw new Error("provider secret must never be returned");
  });
  const runDependency = routeCase.runDependency ?? routeCase.run;
  await expectJson(await runDependency(handlers), 502, {
    error: "User data service is unavailable.",
  });
}

{
  const handlers = createLibraryRouteHandlers({
    createDataClient: async () => ({ getLibrary: async () => library }),
    requireAccess: async () => {
      throw new Error("unexpected secret must never be returned");
    },
  });
  await expectJson(await handlers.GET(), 500, {
    error: "Unexpected user API failure.",
  });
}

console.log(
  `User API auth QA passed (${routeCases.length} methods; signed-out, unconfigured, validation, success, not-found, dependency, and unexpected failures).`,
);
