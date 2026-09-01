import assert from "node:assert/strict";

import { paginateVisibleRows } from "../lib/domain/publication/visible-pagination.ts";

function makeArrayLoader(rows) {
  return async ({ cursor, numItems }) => {
    const start = cursor ? Number.parseInt(cursor, 10) : 0;
    const page = rows.slice(start, start + numItems);
    const next = start + page.length;
    return {
      continueCursor: String(next),
      isDone: next >= rows.length,
      page,
    };
  };
}

const rows = [
  { id: "hidden-1", visible: false },
  { id: "hidden-2", visible: false },
  { id: "event-a", visible: true },
  { id: "hidden-3", visible: false },
  { id: "event-b", visible: true },
  { id: "event-c", visible: true },
  { id: "hidden-4", visible: false },
  { id: "event-d", visible: true },
];
const loadRawPage = makeArrayLoader(rows);
const projectVisible = async (page) => page.filter((row) => row.visible);

const first = await paginateVisibleRows({
  cursor: null,
  loadRawPage,
  numItems: 3,
  projectVisible,
});
assert.deepEqual(first.page.map((row) => row.id), ["event-a", "event-b", "event-c"]);
assert.equal(first.continueCursor, "6");
assert.equal(first.isDone, false);

const second = await paginateVisibleRows({
  cursor: first.continueCursor,
  loadRawPage,
  numItems: 3,
  projectVisible,
});
assert.deepEqual(second.page.map((row) => row.id), ["event-d"]);
assert.equal(second.continueCursor, "8");
assert.equal(second.isDone, true);
assert.deepEqual(
  [...first.page, ...second.page].map((row) => row.id),
  ["event-a", "event-b", "event-c", "event-d"],
  "Visible pagination must not skip or duplicate rows hidden between cursors.",
);

const scanBoundRows = [
  { id: "hidden-a", visible: false },
  { id: "hidden-b", visible: false },
  { id: "hidden-c", visible: false },
  { id: "visible-after-bound", visible: true },
];
const boundedFirst = await paginateVisibleRows({
  cursor: null,
  loadRawPage: makeArrayLoader(scanBoundRows),
  maxRawPages: 2,
  numItems: 1,
  projectVisible,
});
assert.deepEqual(boundedFirst.page, []);
assert.equal(boundedFirst.continueCursor, "2");
assert.equal(boundedFirst.isDone, false);
assert.equal(boundedFirst.scanLimitReached, true);
const boundedSecond = await paginateVisibleRows({
  cursor: boundedFirst.continueCursor,
  loadRawPage: makeArrayLoader(scanBoundRows),
  maxRawPages: 2,
  numItems: 1,
  projectVisible,
});
assert.deepEqual(boundedSecond.page.map((row) => row.id), ["visible-after-bound"]);
assert.equal(boundedSecond.isDone, true);

await assert.rejects(
  paginateVisibleRows({
    cursor: "stalled",
    loadRawPage: async () => ({
      continueCursor: "stalled",
      isDone: false,
      page: [],
    }),
    numItems: 1,
    projectVisible,
  }),
  (error) => error?.code === "RECONCILIATION_CONFLICT",
  "A non-advancing backend cursor must fail closed.",
);

console.log("Public pagination integrity QA passed.");
