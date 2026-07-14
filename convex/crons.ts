import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.weekly(
  "delete expired events",
  {
    dayOfWeek: "wednesday",
    hourUTC: 5,
    minuteUTC: 0,
  },
  internal.maintenance.deleteExpiredEventsUntilDone,
  {
    batchSize: 500,
    maxBatches: 20,
  },
);

crons.weekly(
  "cleanup ingestion artifacts",
  {
    dayOfWeek: "thursday",
    hourUTC: 5,
    minuteUTC: 0,
  },
  internal.maintenance.cleanupIngestionArtifactsUntilDone,
  {
    batchSize: 100,
    maxBatches: 10,
  },
);

crons.daily(
  "cleanup orphaned stored event images",
  {
    hourUTC: 4,
    minuteUTC: 30,
  },
  internal.mediaAssets.pruneOrphanedAssets,
  {
    batchSize: 50,
    minAgeMs: 7 * 24 * 60 * 60 * 1_000,
  },
);

export default crons;
