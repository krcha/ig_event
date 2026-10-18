import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import {
  executeVenueBulkEdit,
  patchVenueForBulkEdit,
  validateVenueBulkPatch,
} from "../lib/admin/venue-bulk-edit.ts";

const makeTargets = () => ["a", "b", "c"].map((id) => ({
  id, name: `Venue ${id}`, category: "venue", publicStatus: "pending", scrapeActive: false,
}));

function transport(respond = () => Response.json({ ok: true })) {
  const requests = [];
  let active = 0;
  let maximum = 0;
  const update = (id, patch) => patchVenueForBulkEdit(id, patch, async (url, options) => {
    active += 1;
    maximum = Math.max(maximum, active);
    try {
      assert.equal(url, "/api/admin/venues");
      assert.equal(options.method, "PATCH");
      assert.equal(options.redirect, "error");
      assert.equal(options.headers["content-type"], "application/json");
      const request = JSON.parse(options.body);
      requests.push(request);
      await Promise.resolve();
      return await respond(request);
    } finally {
      active -= 1;
    }
  });
  return { requests, update, maxActive: () => maximum };
}

for (const invalid of [{}, { name: "Same name" }, { category: "invalid" }, { publicStatus: "bad" }, { scrapeActive: "false" }, { scrapeActive: undefined }]) {
  assert.throws(() => validateVenueBulkPatch(invalid));
  const fake = transport();
  await assert.rejects(executeVenueBulkEdit(makeTargets(), invalid, fake));
  assert.equal(fake.requests.length, 0);
}
assert.deepEqual(validateVenueBulkPatch({ scrapeActive: false }), { scrapeActive: false });
await assert.rejects(executeVenueBulkEdit([], { scrapeActive: true }), /Select at least one/);
await assert.rejects(executeVenueBulkEdit([{ ...makeTargets()[0], id: "" }], { scrapeActive: true }), /missing its ID/);

{
  const fake = transport();
  const targets = makeTargets();
  targets[0].scrapeActive = true;
  const progress = [];
  const result = await executeVenueBulkEdit([targets[0], targets[1], targets[1]], { scrapeActive: true }, { ...fake, onProgress: (value) => progress.push(value) });
  assert.equal(result.total, 2, "selection is deduplicated");
  assert.deepEqual(result.updatedIds, ["b"]);
  assert.deepEqual(result.unchangedIds, ["a"]);
  assert.deepEqual(fake.requests, [{ id: "b", patch: { scrapeActive: true } }], "only selected changed IDs are sent");
  assert.deepEqual(progress.at(-1), { completed: 2, total: 2, updated: 1, unchanged: 1, failed: 0 });
}

{
  const fake = transport();
  const targets = makeTargets().slice(0, 2);
  targets[1] = { ...targets[1], category: "bar", scrapeActive: true };
  await executeVenueBulkEdit(targets, { category: "bar", publicStatus: "published", scrapeActive: true }, fake);
  assert.deepEqual(fake.requests, [
    { id: "a", patch: { category: "bar", publicStatus: "published", scrapeActive: true } },
    { id: "b", patch: { publicStatus: "published" } },
  ], "keep-unchanged fields and entire venue objects never enter the request");
  assert.equal(fake.maxActive(), 1, "bulk updates are sequential");
}

{
  const targets = makeTargets();
  const patch = { scrapeActive: true };
  const fake = transport();
  await executeVenueBulkEdit(targets, patch, { ...fake, onProgress: () => {
    patch.scrapeActive = false;
    targets[1].scrapeActive = true;
    targets[1].id = "unselected";
  } });
  assert.deepEqual(fake.requests.map(({ id }) => id), ["a", "b", "c"], "targets are frozen before asynchronous work");
  assert.ok(fake.requests.every(({ patch: value }) => value.scrapeActive === true), "chosen patch stays frozen");
}

{
  const guardError = "Referenced venue identity/public fields require a bounded venue-rebind migration; no venue was changed.";
  const fake = transport(({ id }) => id === "b" ? Response.json({ error: guardError }, { status: 500 }) : Response.json({ ok: true }));
  const result = await executeVenueBulkEdit(makeTargets(), { scrapeActive: true }, fake);
  assert.deepEqual(result.updatedIds, ["a", "c"]);
  assert.deepEqual(result.failures, [{ id: "b", name: "Venue b", error: guardError, unconfirmed: false }]);
  assert.equal(result.unattempted.length, 0, "one confirmed row rejection does not erase or stop other rows");
}

for (const status of [401, 403, 429]) {
  const fake = transport(({ id }) => id === "b" ? Response.json({ error: "Stop here" }, { status }) : Response.json({ ok: true }));
  const result = await executeVenueBulkEdit(makeTargets(), { scrapeActive: true }, fake);
  assert.deepEqual(fake.requests.map(({ id }) => id), ["a", "b"]);
  assert.deepEqual(result.updatedIds, ["a"]);
  assert.equal(result.failures[0].unconfirmed, false);
  assert.deepEqual(result.unattempted, [{ id: "c", name: "Venue c", reason: "Stop here" }]);
}

for (const reply of [() => { throw new Error("Lost response"); }, () => new Response("<html>Sign in</html>"), () => Response.json({ ok: false }), () => Response.json(null), () => Response.json({}), () => new Response("<html>Bad gateway</html>", { status: 502 }), () => new Response("", { status: 500 }), () => Response.json({ error: "Upstream timeout" }, { status: 503 })]) {
  const fake = transport(({ id }) => id === "b" ? reply() : Response.json({ ok: true }));
  const result = await executeVenueBulkEdit(makeTargets(), { scrapeActive: true }, fake);
  assert.deepEqual(result.updatedIds, ["a"]);
  assert.equal(result.failures[0].unconfirmed, true, "a missing acknowledgement is not a successful update");
  assert.equal(result.unattempted[0].id, "c", "stop and read back after an unconfirmed save");
  assert.equal(fake.requests.length, 2);
}

{
  const persisted = makeTargets();
  const fake = transport(({ id, patch }) => {
    Object.assign(persisted.find((target) => target.id === id), patch);
    if (id === "b") throw new Error("Write succeeded but response was lost");
    return Response.json({ ok: true });
  });
  const first = await executeVenueBulkEdit(makeTargets(), { scrapeActive: true }, fake);
  const retryIds = new Set([...first.failures, ...first.unattempted].map(({ id }) => id));
  const retry = transport();
  const second = await executeVenueBulkEdit(persisted.filter(({ id }) => retryIds.has(id)), { scrapeActive: true }, retry);
  assert.deepEqual(retry.requests, [{ id: "c", patch: { scrapeActive: true } }], "read-back avoids repeating a save with a lost acknowledgement");
  assert.deepEqual(second.unchangedIds, ["b"]);
  assert.deepEqual(second.updatedIds, ["c"]);
  assert.equal(retry.requests.some(({ id }) => id === "a"), false, "successful rows are excluded from retry");
}

{
  const fake = transport();
  const result = await executeVenueBulkEdit(makeTargets(), { scrapeActive: false }, fake);
  assert.deepEqual(result.unchangedIds, ["a", "b", "c"]);
  assert.equal(fake.requests.length, 0, "already matching venues do not trigger writes");
}

// Execute the shipped component handlers, mocking React setters and HTTP only.
const componentSource = readFileSync("components/admin/venue-bulk-edit.tsx", "utf8");
const handlerStart = componentSource.indexOf("  function setBusy(");
const handlerEnd = componentSource.indexOf("  async function refreshBeforeRetry(");
assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
const handlers = ts.transpileModule(componentSource.slice(handlerStart, handlerEnd), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function componentHarness(overrides = {}) {
  const state = {};
  const lock = { current: false };
  const context = {
    operationLock: lock, refreshSucceeded: true, batch: null, result: null,
    venues: makeTargets(), draftPatch: { scrapeActive: true },
    setIsBusy: (value) => { state.busy = value; },
    onBusyChange: (value) => { state.parentBusy = value; },
    setRefreshSucceeded: (value) => { state.refreshed = value; },
    setError: (value) => { state.error = value; },
    setProgress: (value) => { state.progress = value; },
    setBatch: (value) => { state.batch = value; },
    setResult: (value) => { state.result = value; },
    remainingIds: (result) => [...result.failures, ...result.unattempted].map(({ id }) => id),
    onComplete: async (ids) => { state.remaining = ids; return true; },
    ...overrides,
  };
  const apply = new Function(...Object.keys(context), `${handlers}\nreturn applyChanges;`)(...Object.values(context));
  return { apply, state, lock };
}

{
  let finishRefresh;
  let writes = 0;
  const harness = componentHarness({
    executeVenueBulkEdit: async () => {
      writes += 1;
      return { total: 3, updatedIds: ["a", "b", "c"], unchangedIds: [], failures: [], unattempted: [] };
    },
    onComplete: async () => {
      assert.equal(harness.lock.current, true);
      await new Promise((resolve) => { finishRefresh = resolve; });
      return true;
    },
  });
  const first = harness.apply(false);
  await Promise.resolve();
  assert.equal(typeof finishRefresh, "function");
  assert.equal(harness.lock.current, true, "lock stays held while refreshed venue values are pending");
  await harness.apply(false);
  assert.equal(writes, 1, "a same-tick duplicate Apply never starts another batch");
  finishRefresh();
  await first;
  assert.equal(harness.lock.current, false);
  assert.equal(harness.state.parentBusy, false);
  assert.equal(harness.state.refreshed, true);
}

{
  const fake = transport();
  const targets = makeTargets();
  const harness = componentHarness({
    batch: { targets, patch: { scrapeActive: true } },
    draftPatch: { publicStatus: "hidden" },
    result: { total: 3, updatedIds: ["a"], unchangedIds: [], failures: [{ ...targets[1], error: "Lost reply", unconfirmed: true }], unattempted: [{ ...targets[2], reason: "Stopped" }] },
    venues: [{ ...targets[1], scrapeActive: true }, targets[2]],
    executeVenueBulkEdit: (venues, patch, options) => executeVenueBulkEdit(venues, patch, { ...options, update: fake.update }),
    onComplete: async () => false,
  });
  await harness.apply(true);
  assert.deepEqual(fake.requests, [{ id: "c", patch: { scrapeActive: true } }], "actual Retry uses only remaining IDs, refreshed values and the original chosen patch");
  assert.deepEqual(harness.state.result.updatedIds, ["a", "c"]);
  assert.deepEqual(harness.state.result.unchangedIds, ["b"]);
  assert.equal(harness.state.refreshed, false, "refresh failure is reported separately from confirmed writes");
}

console.log("Venue bulk-edit QA passed: selected IDs/fields, no-ops, frozen targets, sequential writes, partial failures, auth/rate stops, uncertain responses, read-back retry, duplicate-click lock and refresh-failure handling.");
