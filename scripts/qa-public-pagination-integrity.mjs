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
let rawPageLoadCount = 0;
const arrayLoader = makeArrayLoader(rows);
const loadRawPage = async (options) => {
  rawPageLoadCount += 1;
  return arrayLoader(options);
};
const projectVisible = async (page) => page.filter((row) => row.visible);

const first = await paginateVisibleRows({
  cursor: null,
  loadRawPage,
  numItems: 3,
  projectVisible,
});
assert.deepEqual(first.page.map((row) => row.id), ["event-a"]);
assert.equal(first.continueCursor, "3");
assert.equal(first.isDone, false);
assert.equal(first.rawPageCount, 1);
assert.equal(rawPageLoadCount, 1, "one Convex function may run only one paginated query");

const second = await paginateVisibleRows({
  cursor: first.continueCursor,
  loadRawPage,
  numItems: 3,
  projectVisible,
});
assert.deepEqual(second.page.map((row) => row.id), ["event-b", "event-c"]);
assert.equal(second.continueCursor, "6");
assert.equal(second.isDone, false);

const third = await paginateVisibleRows({
  cursor: second.continueCursor,
  loadRawPage,
  numItems: 3,
  projectVisible,
});
assert.deepEqual(third.page.map((row) => row.id), ["event-d"]);
assert.equal(third.continueCursor, "8");
assert.equal(third.isDone, true);
assert.deepEqual(
  [...first.page, ...second.page, ...third.page].map((row) => row.id),
  ["event-a", "event-b", "event-c", "event-d"],
  "Short visible pages must not skip or duplicate rows hidden between cursors.",
);

const scanBoundRows = [
  { id: "hidden-a", visible: false },
  { id: "hidden-b", visible: false },
  { id: "hidden-c", visible: false },
  { id: "visible-after-bound", visible: true },
];
const shortFirst = await paginateVisibleRows({
  cursor: null,
  loadRawPage: makeArrayLoader(scanBoundRows),
  numItems: 1,
  projectVisible,
});
assert.deepEqual(shortFirst.page, []);
assert.equal(shortFirst.continueCursor, "1");
assert.equal(shortFirst.isDone, false);
assert.equal(shortFirst.scanLimitReached, false);
const shortSecond = await paginateVisibleRows({
  cursor: shortFirst.continueCursor,
  loadRawPage: makeArrayLoader(scanBoundRows),
  numItems: 3,
  projectVisible,
});
assert.deepEqual(shortSecond.page.map((row) => row.id), ["visible-after-bound"]);
assert.equal(shortSecond.isDone, true);

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
