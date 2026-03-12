import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.hourly(
  "delete expired events",
  {
    minuteUTC: 5,
  },
  internal.events.deleteExpiredEvents,
  {},
);

export default crons;
