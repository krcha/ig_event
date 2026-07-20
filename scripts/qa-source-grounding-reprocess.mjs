import assert from "node:assert/strict";

import { loadExactTargetRows } from "./reprocess-pending-source-grounding.mjs";

const targets = [
  { _id: "event-a", date: "2026-07-20" },
  { _id: "event-b", date: "2026-07-22" },
  { _id: "event-c", date: "2026-07-20" },
];
const rowsByDate = new Map([
  [
    "2026-07-20",
    [
      { _id: "event-a", date: "2026-07-20" },
      { _id: "unrelated", date: "2026-07-20" },
      { _id: "event-c", date: "2026-07-20" },
    ],
  ],
  ["2026-07-22", [{ _id: "event-b", date: "2026-07-22" }]],
]);
let inFlight = 0;
let maxInFlight = 0;
const requestedDates = [];
const client = {
  async query(functionName, args) {
    assert.equal(functionName, "events:listByDate");
    requestedDates.push(args.date);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    if (inFlight > 1) {
      throw new Error("Mock Convex backend rejected overlapping reconciliation queries.");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    return rowsByDate.get(args.date) ?? [];
  },
};

const rows = await loadExactTargetRows(client, "qa-service-secret", targets);
assert.equal(maxInFlight, 1, "Post-apply date queries must be strictly sequential.");
assert.deepEqual(requestedDates, ["2026-07-20", "2026-07-22"]);
assert.deepEqual([...rows.keys()].sort(), ["event-a", "event-b", "event-c"]);
assert.equal(rows.has("unrelated"), false);

console.log("Source-grounding reprocess QA passed: post-apply readback is sequential and exact-ID scoped.");
