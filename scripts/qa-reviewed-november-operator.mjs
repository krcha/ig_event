import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { buildReviewedNovemberPlan, loadReviewedNovemberSnapshot, REVIEWED_NOVEMBER_GROUPS, runReviewedNovemberRepair, stableReviewedJson } from "./repair-reviewed-november-2026.mjs";

const clone = (value) => structuredClone(value);
const contextDigest = (value) => createHash("sha256").update(stableReviewedJson(value)).digest("hex");
function fixture() {
  const state = {
    events: [
      { _id: "j57bcps5x8s9zs8ma39qbwwdr98he2y5", date: "2026-11-06", title: "STABLO MASLINE", time: "18:30", venueId: "k172xcmnd3qw4jqgcswwwrykw5896new", status: "approved", updatedAt: 1, sourceOccurrenceKey: "independent-film-a" },
      { _id: "j576qhgday1np01bdr8rffg5an8he0ze", date: "2026-11-06", title: "PUKOTINA U LEDU", time: "20:30", venueId: "k172xcmnd3qw4jqgcswwwrykw5896new", status: "approved", updatedAt: 1, sourceOccurrenceKey: "independent-film-b" },
      { _id: "j571yaaxec9prd561m0mxdgs4h8h40jz", date: "2026-11-07", title: "\u0110uskali\u0161te", time: "22:00", venueId: "k174najg8yc8jksdmrsps5znr58970vq", status: "approved", updatedAt: 1 },
    ],
    contexts: Object.fromEntries(REVIEWED_NOVEMBER_GROUPS.map((group) => [group.key, {
      groupKey: group.key, primaryId: group.primaryId, complete: false,
      events: [{ _id: group.primaryId, updatedAt: 17 }],
      sourceLinks: [{ id: `source-${group.key}`, updatedAt: 11 }],
      savedReferences: [{ id: `save-${group.key}`, userId: "synthetic-owner", eventId: "duplicate" }],
    }])),
    mutations: [], receipts: [], reads: 0,
    afterRead: null, afterMutation: null,
  };
  const adapter = {
    async query(name, args) {
      state.reads += 1;
      state.afterRead?.(name, args);
      if (name === "events:getManyByIds") return clone(state.events);
      assert.equal(name, "reviewedNovember2026Repairs:getContext");
      const context = clone(state.contexts[args.groupKey]);
      return { ...context, contextSha256: contextDigest(context) };
    },
    async mutation(name, args) {
      state.mutations.push({ name, args: clone(args) });
      assert.equal(name, "reviewedNovember2026Repairs:consolidate");
      assert.equal(args.expectedContextSha256, contextDigest(state.contexts[args.groupKey]), "Backend receives the digest of the complete reviewed context, including saved references.");
      assert.equal(Object.hasOwn(args, "expectedContextJson"), false, "Large source evidence stays in the private receipt instead of a function argument string.");
      state.contexts[args.groupKey].complete = true;
      state.afterMutation?.();
      return { complete: true, primaryId: state.contexts[args.groupKey].events[0]._id };
    },
    async saveReceipt(receipt) { state.receipts.push(clone(receipt)); },
    now: () => "2026-11-06T16:00:00.000Z",
    redactError: () => "synthetic transport error",
  };
  return { state, adapter };
}

{
  const { state, adapter } = fixture();
  const preview = await runReviewedNovemberRepair(adapter);
  assert.equal(preview.nextStep, "dksg-nov6");
  assert.match(preview.planSha256, /^[a-f0-9]{64}$/u);
  assert.equal(state.mutations.length, 0, "Preview is read-only.");
  const protectedBefore = clone(state.events);
  const applied = await runReviewedNovemberRepair(adapter, { apply: true, expectedHash: preview.planSha256 });
  assert.equal(applied.appliedStep, "dksg-nov6");
  assert.equal(applied.nextStep, "bitef-nov6");
  assert.equal(state.mutations.length, 1, "An apply executes only one mutation.");
  assert.deepEqual(state.events, protectedBefore, "Distinct cinema sessions and Saturday party remain independent.");
  assert.equal(state.receipts.at(-1).status, "applied");
  assert.equal(state.receipts.at(-1).before.groups[0].context.complete, false);
  assert.equal(state.receipts.at(-1).after.groups[0].context.complete, true);
  assert.equal(state.receipts.some((receipt) => receipt.status === "applying" && receipt.before.groups[0].context.savedReferences.length === 1), true,
    "Private before receipt with saved-reference preimage is persisted before mutation.");
}

for (const change of [
  (state) => { state.contexts["dksg-nov6"].events[0].updatedAt += 1; },
  (state) => { state.contexts["dksg-nov6"].sourceLinks[0].updatedAt += 1; },
  (state) => { state.contexts["dksg-nov6"].savedReferences.push({ id: "new-save", userId: "another-owner" }); },
]) {
  const { state, adapter } = fixture();
  const preview = await runReviewedNovemberRepair(adapter);
  change(state);
  await assert.rejects(runReviewedNovemberRepair(adapter, { apply: true, expectedHash: preview.planSha256 }), /changed after preview/u);
  assert.equal(state.mutations.length, 0, "Changed event/source/save preimages cannot be applied with an old preview.");
}

{
  const { state, adapter } = fixture();
  const preview = await runReviewedNovemberRepair(adapter);
  const originalSave = adapter.saveReceipt;
  adapter.saveReceipt = async (receipt) => {
    await originalSave(receipt);
    if (receipt.status === "preview" && receipt.mode === "apply-one-step") state.contexts["dksg-nov6"].sourceLinks[0].updatedAt += 1;
  };
  await assert.rejects(runReviewedNovemberRepair(adapter, { apply: true, expectedHash: preview.planSha256 }), /changed before apply/u);
  assert.equal(state.mutations.length, 0, "A second read after recording the before receipt detects concurrent changes.");
  assert.equal(state.receipts.at(-1).status, "failed-or-uncertain");
}

{
  const { state, adapter } = fixture();
  const preview = await runReviewedNovemberRepair(adapter);
  state.events[1].time = "18:30";
  await assert.rejects(runReviewedNovemberRepair(adapter, { apply: true, expectedHash: preview.planSha256 }), /Protected independent event changed/u);
  assert.equal(state.mutations.length, 0, "A changed protected session blocks all incident writes.");
}

{
  const { state, adapter } = fixture();
  const preview = await runReviewedNovemberRepair(adapter, { groupKey: "bife-nov7" });
  state.afterMutation = () => { state.events[0].description = "Unexpected source rewrite"; };
  await assert.rejects(runReviewedNovemberRepair(adapter, { apply: true, expectedHash: preview.planSha256, groupKey: "bife-nov7" }),
    /protected independent performance changed/u);
  assert.equal(state.mutations.length, 1);
  assert.equal(state.receipts.at(-1).status, "failed-or-uncertain");
  assert.equal(state.receipts.at(-1).after.protectedEvents[0].description, "Unexpected source rewrite",
    "A protected source/content change is retained in the failure receipt instead of reporting success.");
}

{
  const { state, adapter } = fixture();
  const preview = await runReviewedNovemberRepair(adapter);
  state.afterMutation = () => { throw new Error("Acknowledgment lost after commit"); };
  await assert.rejects(runReviewedNovemberRepair(adapter, { apply: true, expectedHash: preview.planSha256 }), /Acknowledgment lost/u);
  assert.equal(state.mutations.length, 1, "Uncertain mutations are never retried.");
  assert.equal(state.contexts["dksg-nov6"].complete, true);
  assert.equal(state.receipts.at(-1).status, "failed-or-uncertain");
  state.afterMutation = null;
  assert.equal((await runReviewedNovemberRepair(adapter)).nextStep, "bitef-nov6", "A fresh preview resumes after the committed step.");
}

{
  const { state, adapter } = fixture();
  const preview = await runReviewedNovemberRepair(adapter);
  const originalSave = adapter.saveReceipt;
  adapter.saveReceipt = async () => { throw new Error("Receipt disk unavailable"); };
  await assert.rejects(runReviewedNovemberRepair(adapter, { apply: true, expectedHash: preview.planSha256 }), /Receipt disk unavailable/u);
  assert.equal(state.mutations.length, 0, "A failed before-receipt write prevents production mutation.");
  adapter.saveReceipt = originalSave;
  const snapshot = await loadReviewedNovemberSnapshot(adapter, "tranzit-nov6");
  assert.equal(buildReviewedNovemberPlan(snapshot).next.groupKey, "tranzit-nov6");
  await assert.rejects(loadReviewedNovemberSnapshot(adapter, "all-events"), /Unknown reviewed/u);
  for (const context of Object.values(state.contexts)) context.complete = true;
  assert.equal((await runReviewedNovemberRepair(adapter)).nextStep, null);
}

assert.equal(REVIEWED_NOVEMBER_GROUPS.length, 7, "One incident runner covers all seven reviewed consolidation groups.");
for (const { key } of REVIEWED_NOVEMBER_GROUPS) {
  const { state, adapter } = fixture();
  const preview = await runReviewedNovemberRepair(adapter, { groupKey: key });
  const applied = await runReviewedNovemberRepair(adapter, { apply: true, expectedHash: preview.planSha256, groupKey: key });
  assert.equal(applied.appliedStep, key);
  assert.equal(applied.nextStep, null);
  assert.equal(state.mutations.length, 1);
  assert.equal(Object.values(state.contexts).filter((context) => context.complete).length, 1,
    "Selecting one group cannot consolidate another venue or date.");
}

{
  const { state, adapter } = fixture();
  state.contexts["dksg-nov6"].primaryId = "a-different-event";
  await assert.rejects(runReviewedNovemberRepair(adapter), /wrong pinned group/u);
  assert.equal(state.mutations.length, 0);
}

{
  const { state, adapter } = fixture();
  const query = adapter.query;
  adapter.query = async (name, args) => {
    const result = await query(name, args);
    if (name === "reviewedNovember2026Repairs:getContext") result.contextSha256 = "0".repeat(64);
    return result;
  };
  await assert.rejects(runReviewedNovemberRepair(adapter), /digest does not bind/u);
  assert.equal(state.mutations.length, 0, "A malformed server evidence digest cannot become an actionable preview.");
}

console.log("Reviewed November operator QA passed: exact preview/apply fences, protected sessions, private receipts and uncertain-write recovery.");
