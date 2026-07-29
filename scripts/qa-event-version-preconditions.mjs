import assert from "node:assert/strict";
import { setEventStatus, updateEvent } from "../convex/events.ts";
import { assertExpectedEventUpdatedAt } from "../lib/events/event-update-precondition.ts";

process.env.ADMIN_CLERK_USER_IDS = "qa-owner";

function event(id, overrides = {}) {
  return {
    _id: id,
    _creationTime: 1,
    title: `Concert ${id}`,
    date: "2026-08-01",
    time: "20:00",
    venue: "QA Venue",
    artists: [`Artist ${id}`],
    eventType: "music",
    status: "pending",
    createdAt: 1,
    updatedAt: 100,
    instagramPostId: `post-${id}`,
    instagramPostUrl: `https://www.instagram.com/p/${id}/`,
    ...overrides,
  };
}

function makeCtx(initialEvent) {
  const events = new Map([[initialEvent._id, structuredClone(initialEvent)]]);
  const audits = [];
  const patches = [];
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
        async patch(id, patch) {
          const current = events.get(id);
          if (!current) throw new Error(`missing event ${id}`);
          patches.push({ id, patch: structuredClone(patch) });
          events.set(id, { ...current, ...patch });
        },
        async insert(table, value) {
          assert.equal(table, "eventAuditLog");
          audits.push(structuredClone(value));
          return `audit-${audits.length}`;
        },
      },
    },
    events,
    audits,
    patches,
  };
}

assert.doesNotThrow(() => assertExpectedEventUpdatedAt(100, undefined));
assert.doesNotThrow(() => assertExpectedEventUpdatedAt(100, 100));
assert.throws(() => assertExpectedEventUpdatedAt(100, 99), /reviewed version/i);
assert.throws(() => assertExpectedEventUpdatedAt(100, 100.5), /safe integer/i);

const updateMatch = makeCtx(event("update-match"));
await updateEvent._handler(updateMatch.ctx, {
  id: "update-match",
  patch: { description: "source-reviewed repair" },
  expectedStatus: "pending",
  expectedUpdatedAt: 100,
});
assert.equal(updateMatch.events.get("update-match").description, "source-reviewed repair");
assert.ok(updateMatch.events.get("update-match").updatedAt > 100);
assert.equal(updateMatch.patches.length, 1);
assert.equal(updateMatch.audits.length, 1);

const updateStale = makeCtx(event("update-stale"));
await assert.rejects(
  updateEvent._handler(updateStale.ctx, {
    id: "update-stale",
    patch: { description: "must not commit" },
    expectedStatus: "pending",
    expectedUpdatedAt: 99,
  }),
  /reviewed version/i,
);
assert.equal(updateStale.events.get("update-stale").description, undefined);
assert.equal(updateStale.patches.length, 0);
assert.equal(updateStale.audits.length, 0);

const updateInvalid = makeCtx(event("update-invalid"));
await assert.rejects(
  updateEvent._handler(updateInvalid.ctx, {
    id: "update-invalid",
    patch: { description: "must not commit" },
    expectedStatus: "pending",
    expectedUpdatedAt: 100.5,
  }),
  /safe integer/i,
);
assert.equal(updateInvalid.patches.length, 0);
assert.equal(updateInvalid.audits.length, 0);

const statusMatch = makeCtx(event("status-match"));
await setEventStatus._handler(statusMatch.ctx, {
  id: "status-match",
  status: "rejected",
  reviewedBy: "QA owner",
  moderationNote: "source-reviewed invalid event",
  expectedUpdatedAt: 100,
});
assert.equal(statusMatch.events.get("status-match").status, "rejected");
assert.ok(statusMatch.events.get("status-match").updatedAt > 100);
assert.equal(statusMatch.patches.length, 1);
assert.equal(statusMatch.audits.length, 1);

const statusStale = makeCtx(event("status-stale"));
await assert.rejects(
  setEventStatus._handler(statusStale.ctx, {
    id: "status-stale",
    status: "rejected",
    reviewedBy: "QA owner",
    moderationNote: "must not commit",
    expectedUpdatedAt: 99,
  }),
  /reviewed version/i,
);
assert.equal(statusStale.events.get("status-stale").status, "pending");
assert.equal(statusStale.patches.length, 0);
assert.equal(statusStale.audits.length, 0);

const updateWithoutVersion = makeCtx(event("update-legacy"));
await updateEvent._handler(updateWithoutVersion.ctx, {
  id: "update-legacy",
  patch: { description: "backward compatible" },
  expectedStatus: "pending",
});
assert.equal(updateWithoutVersion.events.get("update-legacy").description, "backward compatible");

const statusWithoutVersion = makeCtx(event("status-legacy"));
await setEventStatus._handler(statusWithoutVersion.ctx, {
  id: "status-legacy",
  status: "rejected",
});
assert.equal(statusWithoutVersion.events.get("status-legacy").status, "rejected");

console.log("Event updatedAt precondition QA passed.");
