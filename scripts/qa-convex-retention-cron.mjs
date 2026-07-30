import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deleteExpiredEvents } from "../convex/events.ts";

const cronsSource = readFileSync(new URL("../convex/crons.ts", import.meta.url), "utf8");
const maintenanceSource = readFileSync(
  new URL("../convex/maintenance.ts", import.meta.url),
  "utf8",
);
const eventsSource = readFileSync(new URL("../convex/events.ts", import.meta.url), "utf8");
const ingestionJobsSource = readFileSync(
  new URL("../convex/ingestionJobs.ts", import.meta.url),
  "utf8",
);
const scrapedPostsSource = readFileSync(
  new URL("../convex/scrapedPosts.ts", import.meta.url),
  "utf8",
);
const retentionSource = readFileSync(
  new URL("../lib/events/event-retention.ts", import.meta.url),
  "utf8",
);

assert.match(
  retentionSource,
  /EVENT_RETENTION_DAYS\s*=\s*2/,
  "event retention should clean events older than the 2-day grace period",
);

assert.match(
  eventsSource,
  /export const deleteExpiredEvents = internalMutation/,
  "expired-event deletion should remain an internal mutation, not a public mutation",
);

assert.match(
  maintenanceSource,
  /export const deleteExpiredEventsUntilDone = internalAction/,
  "weekly retention cron should call an internal action that loops deletion batches until complete",
);
assert.match(
  maintenanceSource,
  /ctx\.runMutation\(deleteExpiredEventsMutation/,
  "retention action should run the bounded internal deletion mutation through a typed function reference",
);
assert.match(
  eventsSource,
  /beforeDate: v\.optional\(v\.string\(\)\)/,
  "operators should be able to request a strict explicit date cutoff without changing cron retention",
);
assert.match(
  eventsSource,
  /dateKeyToUtcMs\(explicitBeforeDate \?\? ""\) === null/,
  "explicit deletion cutoffs must reject invalid calendar dates",
);
assert.match(
  eventsSource,
  /shouldDeleteSameDayExpiredEvents = explicitBeforeDate === undefined/,
  "an explicit beforeDate must preserve every event on the cutoff date",
);
assert.match(
  maintenanceSource,
  /beforeDate: args\.beforeDate/,
  "the bounded all-batches action must forward the explicit strict cutoff to every mutation batch",
);
assert.match(
  maintenanceSource,
  /DEFAULT_EXPIRED_EVENT_CLEANUP_BATCH_SIZE\s*=\s*500/,
  "weekly cleanup should use Convex's bounded 500-event batch size for efficiency",
);
assert.match(
  maintenanceSource,
  /DEFAULT_EXPIRED_EVENT_CLEANUP_MAX_BATCHES\s*=\s*20/,
  "weekly cleanup should have a runaway safety cap while still covering normal data sizes",
);

assert.doesNotMatch(
  cronsSource,
  /crons\.hourly\(\s*["']delete expired events["']/,
  "expired-event cleanup must not run hourly anymore",
);
assert.match(
  cronsSource,
  /crons\.weekly\(\s*["']delete expired events["']/,
  "expired-event cleanup should run weekly",
);
assert.match(cronsSource, /dayOfWeek:\s*["']wednesday["']/, "cleanup should run every Wednesday");
assert.match(cronsSource, /hourUTC:\s*5/, "cleanup should run at 05:00 UTC");
assert.match(cronsSource, /minuteUTC:\s*0/, "cleanup should run exactly at the top of the hour");
assert.match(
  cronsSource,
  /internal\.maintenance\.deleteExpiredEventsUntilDone/,
  "cron should call the all-batches maintenance action",
);
assert.match(cronsSource, /batchSize:\s*500/, "cron should request 500-event deletion batches");
assert.match(cronsSource, /maxBatches:\s*20/, "cron should cap a single weekly cleanup at 20 batches");

assert.match(
  scrapedPostsSource,
  /export const deleteOlderThan = internalMutation/,
  "scraped-post retention should be an internal mutation",
);
assert.match(
  ingestionJobsSource,
  /export const deleteTerminalOlderThan = internalMutation/,
  "terminal ingestion-job retention should be an internal mutation",
);
assert.match(
  maintenanceSource,
  /SCRAPED_POST_RETENTION_MS\s*=\s*90 \* 24 \* 60 \* 60 \* 1000/,
  "scraped posts should retain 90 days by default",
);
assert.match(
  maintenanceSource,
  /INGESTION_JOB_RETENTION_MS\s*=\s*30 \* 24 \* 60 \* 60 \* 1000/,
  "terminal ingestion jobs should retain 30 days by default",
);
assert.match(
  cronsSource,
  /crons\.weekly\(\s*["']cleanup ingestion artifacts["']/,
  "ingestion artifact cleanup should run on a bounded weekly cron",
);
assert.match(
  cronsSource,
  /internal\.maintenance\.cleanupIngestionArtifactsUntilDone/,
  "ingestion artifact cleanup cron should call the internal maintenance action",
);

function makeStrictCutoffCtx() {
  const events = new Map([
    ["event-before", { _id: "event-before", date: "2026-07-25", time: "23:59" }],
    ["event-cutoff", { _id: "event-cutoff", date: "2026-07-26", time: "00:00" }],
  ]);
  const saved = new Map([
    ["saved-before", { _id: "saved-before", eventId: "event-before" }],
    ["saved-cutoff", { _id: "saved-cutoff", eventId: "event-cutoff" }],
  ]);
  const legacySaved = new Map();
  const deleted = [];
  return {
    ctx: {
      db: {
        query(table) {
          return {
            withIndex(_index, buildRange) {
              let constraint;
              buildRange({
                eq(_field, value) {
                  constraint = { kind: "eq", value };
                  return this;
                },
                lt(_field, value) {
                  constraint = { kind: "lt", value };
                  return this;
                },
              });
              return {
                async take(limit) {
                  assert.equal(table, "events");
                  assert.equal(constraint?.kind, "lt");
                  return [...events.values()]
                    .filter((event) => event.date < constraint.value)
                    .slice(0, limit);
                },
                async collect() {
                  const records = table === "savedEvents" ? saved : legacySaved;
                  return [...records.values()].filter(
                    (record) => record.eventId === constraint?.value,
                  );
                },
              };
            },
          };
        },
        async delete(id) {
          deleted.push(id);
          events.delete(id);
          saved.delete(id);
          legacySaved.delete(id);
        },
      },
    },
    deleted,
    events,
    saved,
  };
}

const strictCutoff = makeStrictCutoffCtx();
const strictCutoffResult = await deleteExpiredEvents._handler(strictCutoff.ctx, {
  batchSize: 500,
  beforeDate: "2026-07-26",
});
assert.equal(strictCutoffResult.deletedEventCount, 1);
assert.equal(strictCutoffResult.deletedSavedEventCount, 1);
assert.equal(strictCutoffResult.cutoffDate, "2026-07-26");
assert.equal(strictCutoffResult.cutoffTime, "00:00");
assert.equal(strictCutoffResult.sameDayExpiredEventCount, 0);
assert.equal(strictCutoff.events.has("event-before"), false);
assert.equal(strictCutoff.events.has("event-cutoff"), true);
assert.equal(strictCutoff.saved.has("saved-before"), false);
assert.equal(strictCutoff.saved.has("saved-cutoff"), true);
assert.deepEqual(strictCutoff.deleted.sort(), ["event-before", "saved-before"]);

const invalidCutoff = makeStrictCutoffCtx();
await assert.rejects(
  deleteExpiredEvents._handler(invalidCutoff.ctx, {
    batchSize: 500,
    beforeDate: "2026-02-30",
  }),
  /valid YYYY-MM-DD date/,
);
assert.deepEqual(invalidCutoff.deleted, []);

console.log("Convex retention cron QA passed.");
