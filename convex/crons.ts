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

crons.weekly(
  "cleanup orphaned media assets",
  {
    dayOfWeek: "friday",
    hourUTC: 5,
    minuteUTC: 0,
  },
  internal.maintenance.cleanupOrphanedMediaAssetsUntilDone,
  {
    batchSize: 100,
    maxBatches: 100,
  },
);

export default crons;
