import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function read(path) {
  return readFileSync(path, "utf8");
}

function exportedHandler(source, handlerName) {
  const start = source.indexOf(`export async function ${handlerName}`);
  assert.notEqual(start, -1, `Missing exported handler: ${handlerName}`);
  const end = source.indexOf("\nexport ", start + 1);
  return source.slice(start, end === -1 ? source.length : end);
}

function exportedFacade(source, functionName) {
  const start = source.indexOf(`export const ${functionName}`);
  assert.notEqual(start, -1, `Missing exported facade: ${functionName}`);
  const end = source.indexOf("\nexport const ", start + 1);
  return source.slice(start, end === -1 ? source.length : end);
}

const authConfigSource = read("convex/auth.config.ts");
const authzSource = read("convex/authz.ts");
const eventsSource = read("convex/events.ts");
const compatibilityReadsSource = read("convex/eventDomain/compatibilityReads.ts");
const eventCreationSource = read("convex/eventDomain/eventCreation.ts");
const eventUpdatesSource = read("convex/eventDomain/eventUpdates.ts");
const lifecycleCommandsSource = read("convex/eventDomain/lifecycleCommands.ts");
const moderationCommandsSource = read("convex/eventDomain/moderationCommands.ts");
const moderationReadsSource = read("convex/eventDomain/moderationReads.ts");
const publicReadsSource = read("convex/eventDomain/publicReads.ts");
const sourceGroundingReprocessSource = read(
  "convex/internal/eventRepairs/sourceGroundingReprocess.ts",
);
const eventContractsSource = read("convex/eventDomain/contracts.ts");
const mediaAssetsSource = read("convex/mediaAssets.ts");
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

for (const [functionName, handlerName, implementationSource] of [
  ["getEvent", "getEventHandler", compatibilityReadsSource],
  ["listEvents", "listEventsHandler", compatibilityReadsSource],
  [
    "listModerationDuplicateContextByDates",
    "listModerationDuplicateContextByDatesHandler",
    moderationReadsSource,
  ],
  [
    "classifyPendingModerationUniqueness",
    "classifyPendingModerationUniquenessHandler",
    moderationReadsSource,
  ],
  [
    "approveUniquePendingEvents",
    "approveUniquePendingEventsHandler",
    moderationCommandsSource,
  ],
  ["setEventStatus", "setEventStatusHandler", moderationCommandsSource],
  ["setEventStatuses", "setEventStatusesHandler", moderationCommandsSource],
  ["deleteApprovedEvent", "deleteApprovedEventHandler", lifecycleCommandsSource],
]) {
  assert.match(
    exportedFacade(eventsSource, functionName),
    new RegExp(`handler: ${handlerName}`),
    `${functionName} should bind its reviewed domain handler.`,
  );
  assert.match(
    exportedHandler(implementationSource, handlerName),
    /requireAdminIdentity/,
    `${functionName} should require Convex admin identity.`,
  );
}

for (const [functionName, handlerName, implementationSource] of [
  ["createEvent", "createEventHandler", eventCreationSource],
  ["updateEvent", "updateEventHandler", eventUpdatesSource],
  [
    "reprocessPendingSourceGroundingBatch",
    "reprocessPendingSourceGroundingBatchHandler",
    sourceGroundingReprocessSource,
  ],
  ["listByStatus", "listByStatusHandler", compatibilityReadsSource],
  [
    "listByStatusPaginated",
    "listByStatusPaginatedHandler",
    compatibilityReadsSource,
  ],
  ["listByDate", "listByDateHandler", compatibilityReadsSource],
  [
    "getByInstagramPostId",
    "getByInstagramPostIdHandler",
    compatibilityReadsSource,
  ],
  [
    "getByInstagramPostUrl",
    "getByInstagramPostUrlHandler",
    compatibilityReadsSource,
  ],
]) {
  assert.match(
    exportedFacade(eventsSource, functionName),
    new RegExp(`handler: ${handlerName}`),
    `${functionName} should bind its reviewed domain handler.`,
  );
  assert.match(
    exportedHandler(implementationSource, handlerName),
    /requireAdminOrServiceSecret/,
    `${functionName} should require admin or service secret.`,
  );
}

const reprocessMutationSource = eventsSource.match(
  /export const reprocessPendingSourceGroundingBatch = mutation\(\{([\s\S]*?)\n\}\);/,
)?.[1];
assert.ok(reprocessMutationSource, "Source-grounding reprocessing mutation should exist.");
assert.match(
  reprocessMutationSource,
  /serviceSecret:\s*v\.string\(\)/,
  "Source-grounding reprocessing must require an explicit service secret.",
);
assert.match(
  sourceGroundingReprocessSource,
  /kind !== "service"/,
  "Source-grounding reprocessing must reject authenticated admin fallback.",
);
assert.match(
  eventContractsSource,
  /const sourceGroundingReprocessItem = v\.object\(\{\s*id: v\.id\("events"\),\s*expectedUpdatedAt: v\.number\(\),\s*expectedNormalizedFieldsJson: v\.string\(\),\s*nextNormalizedFieldsJson: v\.string\(\),\s*\}\);/,
  "The reprocessing payload must contain only the event ID and exact attestation preconditions.",
);
assert.doesNotMatch(
  reprocessMutationSource.match(/args:\s*\{([\s\S]*?)\n\s*\},\n\s*handler:/)?.[1] ?? "",
  /\b(?:patch|title|date|time|venue|artists|sourceCaption|instagramPostId|instagramPostUrl)\b/,
  "The reprocessing mutation must not accept caller-controlled public or source fields.",
);

assert.match(
  eventsSource,
  /export const getPublicApprovedEvent = query[\s\S]*handler: getPublicApprovedEventHandler/,
  "Public event detail query should bind the approved-only domain handler.",
);
assert.match(
  publicReadsSource,
  /export async function getPublicApprovedEventHandler[\s\S]*event\.status !== "approved"/,
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
  /mediaAssets:getPublicEventImageSource/,
  "Discover image proxy should use the public event image-source query.",
);
assert.match(
  mediaAssetsSource,
  /import \{[\s\S]*?isEventPubliclyVisible,[\s\S]*?\} from "\.\/publicationPolicy";/,
  "Public event image authorization should use the shared publication policy.",
);
assert.match(
  mediaAssetsSource,
  /export const getPublicEventImageSource = query\([\s\S]*?const event = await ctx\.db\.get\(eventId\);[\s\S]*?!\(await isEventPubliclyVisible\(ctx, event\)\)[\s\S]*?eventExists: false/,
  "Public event image-source query should fail closed unless the event passes live publication visibility.",
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
