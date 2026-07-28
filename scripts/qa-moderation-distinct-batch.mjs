import assert from "node:assert/strict";
import { setEventStatuses } from "../convex/events.ts";

process.env.ADMIN_CLERK_USER_IDS = "qa-owner";

function event(id, overrides = {}) {
  return {
    _id: id,
    _creationTime: 1,
    title: `Concert ${id}`,
    date: "2026-08-01",
    time: "20:00",
    venue: "Shared Venue",
    artists: [`Artist ${id}`],
    eventType: "music",
    status: "pending",
    createdAt: 1,
    updatedAt: 1,
    instagramPostId: `post-${id}`,
    instagramPostUrl: `https://www.instagram.com/p/${id}/`,
    ...overrides,
  };
}

function makeCtx(initialEvents) {
  const events = new Map(initialEvents.map((item) => [item._id, structuredClone(item)]));
  const audits = [];
  const filterRows = (rows, filters) =>
    rows.filter((row) => filters.every(([field, value]) => row[field] === value));
  const query = (table) => {
    const rows = () => table === "events" ? [...events.values()] : [];
    return {
      async collect() {
        return rows();
      },
      withIndex(_name, applyIndex) {
        const filters = [];
        const chain = {
          eq(field, value) {
            filters.push([field, value]);
            return chain;
          },
        };
        applyIndex(chain);
        return {
          async collect() {
            return filterRows(rows(), filters);
          },
        };
      },
    };
  };
  return {
    ctx: {
      auth: {
        async getUserIdentity() {
          return { subject: "qa-owner" };
        },
      },
      db: {
        async get(id) {
          return events.get(id) ?? null;
        },
        query,
        async patch(id, patch) {
          const current = events.get(id);
          if (!current) throw new Error(`missing event ${id}`);
          events.set(id, { ...current, ...patch });
        },
        async insert(table, value) {
          assert.equal(table, "eventAuditLog");
          audits.push(value);
          return `audit-${audits.length}`;
        },
      },
    },
    events,
    audits,
  };
}

async function moderate(initialEvents, args) {
  const state = makeCtx(initialEvents);
  const result = await setEventStatuses._handler(state.ctx, {
    reviewedBy: "QA owner",
    moderationNote: "source-reviewed distinct occurrences",
    ...args,
  });
  return { ...state, result };
}

const pair = [event("one"), event("two", { title: "Different billed concert" })];

const defaultBatch = await moderate(pair, {
  ids: ["one", "two"],
  status: "approved",
});
assert.deepEqual(defaultBatch.result, { updatedCount: 1, skippedCount: 1 });
assert.equal(defaultBatch.events.get("one").status, "approved");
assert.equal(defaultBatch.events.get("two").status, "pending");

const distinctBatch = await moderate(pair, {
  ids: ["one", "two"],
  status: "approved",
  approveAsDistinctSameVenueDateBatch: true,
});
assert.deepEqual(distinctBatch.result, { updatedCount: 2, skippedCount: 0 });
assert.deepEqual(
  [distinctBatch.events.get("one").status, distinctBatch.events.get("two").status],
  ["approved", "approved"],
);
assert.equal(distinctBatch.audits.length, 2);

const outsideConflict = event("outside", {
  title: "Already approved outside event",
  status: "approved",
});
const blockedByOutside = await moderate([...pair, outsideConflict], {
  ids: ["one", "two"],
  status: "approved",
  approveAsDistinctSameVenueDateBatch: true,
});
assert.deepEqual(blockedByOutside.result, { updatedCount: 0, skippedCount: 2 });
assert.equal(blockedByOutside.events.get("one").status, "pending");
assert.equal(blockedByOutside.events.get("two").status, "pending");
assert.equal(blockedByOutside.audits.length, 0);

await assert.rejects(
  moderate(pair, {
    ids: ["one"],
    status: "approved",
    approveAsDistinctSameVenueDateBatch: true,
  }),
  /requires at least two approved event IDs/i,
);
await assert.rejects(
  moderate(pair, {
    ids: ["one", "two"],
    status: "rejected",
    approveAsDistinctSameVenueDateBatch: true,
  }),
  /requires at least two approved event IDs/i,
);

console.log("Moderation distinct same-venue/date batch QA passed.");
