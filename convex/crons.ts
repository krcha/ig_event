import { cronJobs } from "convex/server";
import type { FunctionReference } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Each invocation performs a small amount of real work and returns its counts.
// The underlying mutations persist their cutoff and cursor atomically, so later
// ticks resume interrupted or capped scans without a long-running action loop.
crons.interval(
  "delete expired events",
  {
    minutes: 5,
  },
  internal.maintenance.deleteExpiredEventsUntilDone,
  {
    batchSize: 1,
    maxBatches: 5,
  },
);

crons.hourly(
  "cleanup ingestion artifacts",
  {
    minuteUTC: 7,
  },
  internal.maintenance.cleanupIngestionArtifactsUntilDone,
  {
    batchSize: 25,
    maxBatches: 2,
  },
);

crons.interval(
  "cleanup orphaned media assets",
  {
    minutes: 15,
  },
  internal.maintenance.cleanupOrphanedMediaAssetsUntilDone,
  {
    batchSize: 5,
    maxBatches: 5,
  },
);

// Scan a bounded slice of pending rows on each tick. The mutation rechecks
// source, full occurrence topology, and same-date uniqueness before a write;
// the durable cursor eventually revisits rows that were not yet eligible.
const automaticUniqueSweep =
  "internal/automaticUniqueApproval:sweepUntilDone" as unknown as FunctionReference<
    "action",
    "internal",
    { maxPages?: number }
  >;
crons.interval(
  "approve server-verified unique events",
  { minutes: 1 },
  automaticUniqueSweep,
  { maxPages: 60 },
);

export default crons;
