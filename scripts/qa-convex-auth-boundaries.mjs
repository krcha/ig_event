import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function read(path) {
  return readFileSync(path, "utf8");
}

const authConfigSource = read("convex/auth.config.ts");
const authzSource = read("convex/authz.ts");
const eventsSource = read("convex/events.ts");
const usersSource = read("convex/users.ts");
const venuesSource = read("convex/venues.ts");
const eventDetailSource = read("app/(main)/events/[eventId]/page.tsx");
const discoverImageRouteSource = read("app/api/discover/images/[eventId]/route.ts");
const adminEventsRouteSource = read("app/api/admin/events/route.ts");

assert.match(
  authConfigSource,
  /CLERK_JWT_ISSUER_DOMAIN/,
  "Convex auth config should read Clerk JWT issuer from env.",
);
assert.match(
  authConfigSource,
  /applicationID:\s*"convex"/,
  "Convex auth config should use Clerk JWT template applicationID=convex.",
);
assert.match(
  authzSource,
  /export async function requireViewerIdentity/,
  "Convex auth helpers should expose requireViewerIdentity.",
);
assert.match(
  authzSource,
  /export async function requireAdminIdentity/,
  "Convex auth helpers should expose requireAdminIdentity.",
);
assert.match(
  authzSource,
  /export async function requireAdminOrServiceSecret/,
  "Convex auth helpers should expose requireAdminOrServiceSecret.",
);
assert.match(
  authzSource,
  /ADMIN_CLERK_USER_IDS/,
  "Admin checks should use the Clerk admin allowlist in Convex.",
);
assert.match(
  authzSource,
  /CRON_SECRET/,
  "Service-secret checks should use CRON_SECRET in Convex.",
);

for (const functionName of [
  "getEvent",
  "listEvents",
  "setEventStatus",
  "setEventStatuses",
  "deleteApprovedEvent",
]) {
  const pattern = new RegExp(`export const ${functionName} = [\\s\\S]*?requireAdminIdentity`);
  assert.match(eventsSource, pattern, `${functionName} should require Convex admin identity.`);
}

for (const functionName of [
  "createEvent",
  "updateEvent",
  "listByStatus",
  "listByStatusPaginated",
  "listByDate",
  "getByInstagramPostId",
  "getByInstagramPostUrl",
]) {
  const pattern = new RegExp(`export const ${functionName} = [\\s\\S]*?requireAdminOrServiceSecret`);
  assert.match(eventsSource, pattern, `${functionName} should require admin or service secret.`);
}

assert.match(
  eventsSource,
  /export const getPublicApprovedEvent = query[\s\S]*event\.status !== "approved"/,
  "Public event detail query should return only approved events.",
);
assert.match(
  eventDetailSource,
  /events:getPublicApprovedEvent/,
  "Public event detail page should use the approved-only Convex query.",
);
assert.match(
  eventDetailSource,
  /notFound\(\)/,
  "Public event detail page should render a real 404 when the approved event query returns null.",
);
assert.match(
  discoverImageRouteSource,
  /events:getPublicApprovedEvent/,
  "Discover image proxy should use the approved-only event query.",
);

for (const functionName of [
  "getMyLibrary",
  "updatePreferences",
  "toggleMySavedEvent",
  "toggleMyFavoriteVenue",
]) {
  const pattern = new RegExp(`export const ${functionName} = [\\s\\S]*?requireViewerIdentity`);
  assert.match(usersSource, pattern, `${functionName} should derive identity from the authenticated viewer.`);
}

for (const functionName of [
  "listVenues",
  "listVenueIngestionFieldsPaginated",
  "listActiveVenueIngestionFieldsPaginated",
  "createVenue",
  "updateVenue",
  "patchVenueHours",
]) {
  const pattern = new RegExp(`export const ${functionName} = [\\s\\S]*?requireAdminOrServiceSecret`);
  assert.match(venuesSource, pattern, `${functionName} should require admin or service secret.`);
}

assert.match(
  venuesSource,
  /export const listPublicVenueFieldsByIds = query/,
  "Venues should expose a narrow public fields-by-ID query.",
);
assert.match(
  adminEventsRouteSource,
  /createAuthenticatedConvexHttpClient/,
  "Admin event route should forward Clerk auth to Convex.",
);

console.log("Convex auth-boundary QA passed.");
