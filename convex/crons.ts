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

export default crons;
