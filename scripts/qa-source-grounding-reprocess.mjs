import assert from "node:assert/strict";

import {
  getSourceGroundingReprocessReasonGate,
  loadExactTargetRows,
  loadPendingEventsPaginated,
} from "./reprocess-pending-source-grounding.mjs";

assert.deepEqual(
  getSourceGroundingReprocessReasonGate(
    JSON.stringify({
      moderationPendingReasons: [
        "caption_source_event_mismatch",
        "requires_human_approval",
      ],
    }),
  ),
  { hasSourceGroundingReason: true, nonRemovablePendingReasons: [] },
);
assert.deepEqual(
  getSourceGroundingReprocessReasonGate(
    JSON.stringify({
      moderationPendingReasons: [
        "unverified_core_event_source",
        "manual_safety_hold",
      ],
    }),
  ),
  { hasSourceGroundingReason: true, nonRemovablePendingReasons: ["manual_safety_hold"] },
);

const targets = Array.from({ length: 205 }, (_, index) => ({
  _id: `event-${index.toString().padStart(3, "0")}`,
  date: "2026-07-20",
}));
let inFlight = 0;
let maxInFlight = 0;
const requestedIdBatches = [];
const client = {
  async query(functionName, args) {
    assert.equal(functionName, "events:getManyByIds");
    requestedIdBatches.push(args.ids);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    if (inFlight > 1) {
      throw new Error("Mock Convex backend rejected overlapping reconciliation queries.");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    return args.ids.map((id) => ({ _id: id, date: "2026-07-20" }));
  },
};

const rows = await loadExactTargetRows(client, "qa-service-secret", targets);
assert.equal(maxInFlight, 1, "Post-apply exact-ID queries must be strictly sequential.");
assert.deepEqual(requestedIdBatches.map((batch) => batch.length), [100, 100, 5]);
assert.deepEqual([...rows.keys()].sort(), targets.map((event) => event._id));

const pendingPages = [
  { page: [{ _id: "pending-a" }, { _id: "pending-b" }], isDone: false, continueCursor: "cursor-2" },
  { page: [{ _id: "pending-c" }], isDone: true, continueCursor: "cursor-done" },
];
const pendingRequests = [];
const pendingClient = {
  async query(functionName, args) {
    assert.equal(functionName, "events:listByStatusPaginated");
    pendingRequests.push(args);
    return pendingPages[pendingRequests.length - 1];
  },
};
const pendingRows = await loadPendingEventsPaginated(pendingClient, "qa-service-secret");
assert.deepEqual(pendingRows.map((event) => event._id), ["pending-a", "pending-b", "pending-c"]);
assert.deepEqual(
  pendingRequests.map((request) => request.paginationOpts),
  [
    { numItems: 20, cursor: null },
    { numItems: 20, cursor: "cursor-2" },
  ],
);

await assert.rejects(
  () =>
    loadPendingEventsPaginated(
      {
        async query() {
          return {
            page: [{ _id: "incomplete" }],
            isDone: true,
            continueCursor: "range-end",
            pageStatus: "SplitRequired",
            splitCursor: "range-middle",
          };
        },
      },
      "qa-service-secret",
    ),
  /requires a split; refusing a partial backlog read/,
);

console.log("Source-grounding reprocess QA passed: pending reads fail closed on split ranges and post-apply readback is sequential/exact-ID scoped.");
