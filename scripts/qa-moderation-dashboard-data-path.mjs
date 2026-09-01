import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  MAX_MODERATION_DUPLICATE_CONTEXT_DATES,
  getModerationDuplicateContextDates,
  loadModerationDuplicateContextWithFallback,
  mergeModerationDuplicateContextEvents,
} from "../lib/events/moderation-duplicate-context.ts";

function read(path) {
  return readFileSync(path, "utf8");
}

function section(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `Missing section start: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `Missing section end: ${end}`);
  return source.slice(startIndex, endIndex);
}

const dateFixtures = Array.from({ length: 205 }, (_, index) => ({
  date: new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10),
}));
dateFixtures.splice(1, 0, { date: dateFixtures[0].date });
const boundedDates = getModerationDuplicateContextDates(dateFixtures);
assert.equal(boundedDates.length, MAX_MODERATION_DUPLICATE_CONTEXT_DATES);
assert.equal(boundedDates[0], dateFixtures[0].date);
assert.equal(boundedDates[1], dateFixtures[2].date);
assert.equal(
  new Set(boundedDates).size,
  boundedDates.length,
  "Duplicate-context dates must be unique before reaching Convex.",
);

let disabledLoadCount = 0;
const disabledResult = await loadModerationDuplicateContextWithFallback({
  baseEvents: ["base"],
  includeDuplicateContext: false,
  loadContext: async () => {
    disabledLoadCount += 1;
    return { events: ["context"], truncated: false };
  },
});
assert.deepEqual(disabledResult, {
  duplicateContextEvents: [],
  degraded: false,
  truncated: false,
});
assert.equal(disabledLoadCount, 0);

const loadedResult = await loadModerationDuplicateContextWithFallback({
  baseEvents: ["base"],
  includeDuplicateContext: true,
  loadContext: async () => ({ events: ["context"], truncated: false }),
});
assert.deepEqual(loadedResult, {
  duplicateContextEvents: ["context"],
  degraded: false,
  truncated: false,
});

const truncatedResult = await loadModerationDuplicateContextWithFallback({
  baseEvents: ["base"],
  includeDuplicateContext: true,
  loadContext: async () => ({ events: ["context"], truncated: true }),
});
assert.deepEqual(truncatedResult, {
  duplicateContextEvents: ["context"],
  degraded: true,
  truncated: true,
});

const expectedError = new Error("duplicate context unavailable");
let reportedError = null;
const baseEvents = [{ id: "event-1" }];
const degradedResult = await loadModerationDuplicateContextWithFallback({
  baseEvents,
  includeDuplicateContext: true,
  loadContext: async () => {
    throw expectedError;
  },
  onLoadError: (error) => {
    reportedError = error;
  },
});
assert.equal(degradedResult.duplicateContextEvents, baseEvents);
assert.equal(degradedResult.degraded, true);
assert.equal(degradedResult.truncated, false);
assert.equal(reportedError, expectedError);

const mergedEvents = mergeModerationDuplicateContextEvents(
  [
    { id: "base-1", source: "base" },
    { id: "shared", source: "base" },
  ],
  [
    { id: "shared", source: "context" },
    { id: "context-1", source: "context" },
  ],
);
assert.deepEqual(
  mergedEvents,
  [
    { id: "base-1", source: "base" },
    { id: "shared", source: "base" },
    { id: "context-1", source: "context" },
  ],
  "Every base-page row must survive a truncated context response, with duplicate ids removed.",
);

const eventsSource = read("convex/events.ts");
const moderationReadsSource = read("convex/eventDomain/moderationReads.ts");
const routeSource = read("app/api/admin/events/route.ts");
const dashboardSource = read("components/admin/moderation-dashboard.tsx");
const authQaSource = read("scripts/qa-convex-auth-boundaries.mjs");
const packageJson = JSON.parse(read("package.json"));
const releaseCheckSource = read("scripts/release-check.mjs");

const projectionSource = section(
  moderationReadsSource,
  "function projectModerationDuplicateContextEvent",
  "export async function listModerationDuplicateContextByDatesHandler",
);
for (const heavyField of [
  "rawExtractionJson",
  "normalizedFieldsJson",
  "imageUrl",
  "imageStorageId",
]) {
  assert.doesNotMatch(
    projectionSource,
    new RegExp(heavyField),
    `Duplicate context must not return heavyweight ${heavyField} data.`,
  );
}
assert.match(projectionSource, /MODERATION_DUPLICATE_CONTEXT_CAPTION_LENGTH/);
assert.match(projectionSource, /MODERATION_DUPLICATE_CONTEXT_DESCRIPTION_LENGTH/);

const queryFacadeSource = section(
  eventsSource,
  "export const listModerationDuplicateContextByDates",
  "export const getPublicApprovedEvent",
);
assert.match(queryFacadeSource, /args:\s*\{\s*dates: v\.array\(v\.string\(\)\)/);
assert.match(queryFacadeSource, /returns: moderationDuplicateContextResult/);
assert.match(
  queryFacadeSource,
  /handler: listModerationDuplicateContextByDatesHandler/,
);
const querySource = section(
  moderationReadsSource,
  "export async function listModerationDuplicateContextByDatesHandler",
  "export async function classifyPendingModerationUniquenessHandler",
);
assert.match(querySource, /await requireAdminIdentity\(ctx\)/);
assert.match(querySource, /args\.dates\.length > MAX_MODERATION_DUPLICATE_CONTEXT_DATES/);
assert.match(
  querySource,
  /withIndex\("by_status_date", \(q\) =>[\s\S]{0,100}q\.eq\("status", "approved"\)\.eq\("date", date\)/,
  "Duplicate context must reserve its bounded reads for approved conflict candidates.",
);
assert.match(
  querySource,
  /take\(MAX_MODERATION_DUPLICATE_CONTEXT_EVENTS_PER_DATE \+ 1\)/,
  "Each date cohort must read one sentinel row so truncation is explicit.",
);
assert.match(querySource, /MAX_MODERATION_DUPLICATE_CONTEXT_EVENTS/);
assert.match(querySource, /remainingCapacity/);
assert.match(querySource, /truncated = true/);
assert.match(querySource, /return \{ events: contextEvents, truncated \}/);
assert.match(
  querySource,
  /Math\.ceil\(\s*remainingCapacity\s*\/\s*MAX_MODERATION_DUPLICATE_CONTEXT_EVENTS_PER_DATE/,
  "The final batch must shrink instead of reading a full four-date batch past the row budget.",
);
assert.doesNotMatch(querySource, /\.collect\(\)/);
assert.match(
  moderationReadsSource,
  /const MAX_MODERATION_DUPLICATE_CONTEXT_EVENTS = 100;/,
  "Duplicate-context output must remain capped at the known-safe 100 rows.",
);
assert.match(
  moderationReadsSource,
  /const MAX_MODERATION_DUPLICATE_CONTEXT_EVENTS_PER_DATE = 8;/,
  "Each date query must read no more than eight event documents.",
);
assert.match(
  moderationReadsSource,
  /const MODERATION_DUPLICATE_CONTEXT_DATE_BATCH_SIZE = 4;/,
  "Date reads must use small batches so the global row cap is checked frequently.",
);
assert.equal(
  MAX_MODERATION_DUPLICATE_CONTEXT_DATES,
  100,
  "The route must not ask Convex for more than 100 date cohorts.",
);

assert.match(routeSource, /events:listModerationDuplicateContextByDates/);
assert.doesNotMatch(routeSource, /events:listEvents/);
assert.match(routeSource, /getModerationDuplicateContextDates\(events\)/);
assert.match(routeSource, /loadModerationDuplicateContextWithFallback/);
assert.match(routeSource, /baseEvents: mappedEvents/);
assert.match(routeSource, /mergeModerationDuplicateContextEvents\(/);
assert.match(routeSource, /duplicateContextDegraded: duplicateContext\.degraded/);
assert.match(routeSource, /duplicateContextTruncated: duplicateContext\.truncated/);
assert.match(dashboardSource, /payload\.duplicateContextDegraded === true/);
assert.match(dashboardSource, /payload\.duplicateContextTruncated === true/);
assert.match(
  dashboardSource,
  /approved duplicate comparison reached its safety limit/,
);
assert.match(authQaSource, /listModerationDuplicateContextByDates/);

assert.ok(
  packageJson.scripts["qa:moderation-dashboard-data"]?.includes(
    "qa-moderation-dashboard-data-path.mjs",
  ),
  "package.json should expose focused moderation dashboard data-path QA.",
);
assert.match(
  releaseCheckSource,
  /qa:moderation-dashboard-data/,
  "Release gate should include moderation dashboard data-path QA.",
);

console.log("QA passed: moderation dashboard uses bounded, resilient duplicate context.");
