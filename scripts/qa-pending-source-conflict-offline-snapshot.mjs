import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";

import {
  previewPendingCinemaSourceConflictReclassificationHandler,
  reclassifyPendingCinemaSourceConflictsHandler,
} from "../convex/internal/eventRepairs/pendingSourceConflictReclassification.ts";

const [archivePath, summaryPath] = process.argv.slice(2);
if (!archivePath || !summaryPath) {
  throw new Error("Usage: qa-pending-source-conflict-offline-snapshot <Convex ZIP> <conflict summary JSON>");
}

function readTable(table) {
  const output = execFileSync(
    "unzip",
    ["-p", archivePath, `${table}/documents.jsonl`],
    { encoding: "utf8", maxBuffer: 80 * 1024 * 1024 },
  );
  return output.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
const cinemaRows = summary.conflicts.filter((item) =>
  item.materialConflicts?.length === 1 &&
  item.materialConflicts[0].field === "date" &&
  /\bu bioskopima\b/iu.test(item.materialConflicts[0].reason),
);
assert.equal(cinemaRows.length, 10, "The inspected snapshot must contain exactly ten cinema rows.");
const targetIds = new Set(cinemaRows.map((item) => item.eventId));
const events = readTable("events").filter((item) => targetIds.has(item._id));
assert.equal(events.length, targetIds.size);
const links = readTable("instagramEventSources").filter((item) => targetIds.has(item.eventId));
const sourceIdentities = new Set(links.map((item) => item.sourceIdentity));
const receipts = readTable("instagramSourceOccurrenceReceipts")
  .filter((item) => sourceIdentities.has(item.sourceIdentity));
const occurrenceIds = new Set(links.map((item) => item.sourceOccurrenceId));
const occurrences = readTable("sourceOccurrences")
  .filter((item) => occurrenceIds.has(item._id));
const postIds = new Set(events.map((item) => item.instagramPostId));
const sources = readTable("scrapedPosts")
  .filter((item) => postIds.has(item.postId));
const records = new Map(
  [...events, ...links, ...receipts, ...occurrences, ...sources]
    .map((row) => [row._id, row]),
);
const audits = [];
const tables = { events, instagramEventSources: links,
  instagramSourceOccurrenceReceipts: receipts, sourceOccurrences: occurrences,
  scrapedPosts: sources };
const ctx = {
  auth: { getUserIdentity: async () => null },
  db: {
    get: async (id) => records.get(id) ?? null,
    patch: async (id, patch) => records.set(id, { ...records.get(id), ...patch }),
    insert: async (table, record) => {
      assert.equal(table, "eventAuditLog");
      audits.push(record);
      return `offline-audit-${audits.length}`;
    },
    query: (table) => ({
      withIndex: (_index, callback) => {
        const constraints = [];
        const builder = { eq: (name, expected) => {
          constraints.push([name, expected]);
          return builder;
        } };
        callback(builder);
        return { take: async (limit) =>
          (tables[table] ?? []).filter((row) =>
            constraints.every(([field, value]) => row[field] === value),
          ).slice(0, limit) };
      },
    }),
  },
};

const originalSecret = process.env.CRON_SECRET;
process.env.CRON_SECRET = "offline-cinema-conflict-test";
try {
  let repaired = 0;
  for (const sourceIdentity of sourceIdentities) {
    const ids = links.filter((item) => item.sourceIdentity === sourceIdentity)
      .map((item) => item.eventId);
    const before = ids.map((id) => ({ ...records.get(id) }));
    let preview;
    try {
      preview = await previewPendingCinemaSourceConflictReclassificationHandler(ctx, {
        sourceIdentity,
        eventIds: ids,
        serviceSecret: process.env.CRON_SECRET,
      });
    } catch (error) {
      for (const id of ids) {
        const event = records.get(id);
        const fields = JSON.parse(event.normalizedFieldsJson);
        const issue = fields.materialSourceConflicts?.[0];
        console.error("Offline candidate", id, event.title, event.date,
          "poster", issue?.poster_value, "caption", issue?.caption_value,
          "identity", fields.identityEvidenceVerified);
      }
      throw error;
    }
    assert.equal(preview.items.length, ids.length);
    assert.ok(preview.items.every((item) =>
      item.previousMaterialCount === 1 && item.nextBenignCount === 1,
    ));
    const result = await reclassifyPendingCinemaSourceConflictsHandler(ctx, {
      sourceIdentity: preview.sourceIdentity,
      expectedReceiptId: preview.expectedReceiptId,
      expectedReceiptUpdatedAt: preview.expectedReceiptUpdatedAt,
      expectedSourceFingerprint: preview.expectedSourceFingerprint,
      items: preview.items.map(({ previousMaterialCount, nextBenignCount, ...item }) => item),
      serviceSecret: process.env.CRON_SECRET,
    });
    assert.equal(result.updatedCount, ids.length);
    for (const old of before) {
      const next = records.get(old._id);
      assert.equal(next.status, "pending");
      for (const field of [
        "rawExtractionJson", "sourceCaption", "sourcePostedAt", "date", "time",
        "title", "venue", "artists", "sourceOccurrenceKey", "instagramPostId",
        "instagramPostUrl",
      ]) {
        assert.deepEqual(next[field], old[field], `${old._id} changed ${field}`);
      }
      assert.deepEqual(next.sourceConflictFields, []);
      const fields = JSON.parse(next.normalizedFieldsJson);
      assert.deepEqual(fields.materialSourceConflicts, []);
      assert.equal(fields.benignSourceConflictCount, 1);
      assert.equal(fields.moderationAutoApproved, false);
      assert.ok(fields.moderationPendingReasons.includes("requires_human_approval"));
      assert.equal(fields.structuredEvidenceVerified, fields.identityEvidenceVerified);
      assert.equal(
        fields.moderationPendingReasons.includes("invalid_identity_evidence"),
        fields.identityEvidenceVerified === false,
      );
    }
    repaired += ids.length;
  }
  assert.equal(repaired, 10);
  assert.equal(audits.length, 10);
  console.log(`Offline snapshot QA passed: ${repaired} cinema rows, ${sourceIdentities.size} complete source receipt(s).`);
} finally {
  if (originalSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = originalSecret;
}
