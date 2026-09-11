import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { syncSourceOccurrencePlan } from "../convex/sourceOccurrences.ts";
import { reconcileExistingSourceOccurrenceReceipt } from "../convex/internal/sourceOccurrenceReceipts.ts";
import { sourceOccurrenceProvenanceRepository } from "../convex/repositories/sourceOccurrenceProvenance.ts";

function unreadableContext() {
  return {
    get db() {
      throw new Error("Writer read the database before checking its topology capability.");
    },
  };
}

await assert.rejects(
  () => syncSourceOccurrencePlan({ ctx: unreadableContext() }),
  /explicit topology epoch classification/i,
  "Raw occurrence sync must reject a caller that omits the epoch classification.",
);

await assert.rejects(
  () =>
    reconcileExistingSourceOccurrenceReceipt(
      unreadableContext(),
      { expectedKeys: [], expectedOccurrences: [] },
    ),
  /explicit topology epoch classification/i,
  "Raw receipt reconciliation must reject a caller that omits the epoch classification.",
);

await assert.rejects(
  () =>
    sourceOccurrenceProvenanceRepository.supersedeAndDetachEvent(
      unreadableContext(),
      "event_1",
    ),
  /explicit epoch classification/i,
  "Detachment must reject an unclassified topology mutation before reads or writes.",
);

await assert.rejects(
  () =>
    sourceOccurrenceProvenanceRepository.removeLegacyBindingsForDeletedEvent(
      unreadableContext(),
      "event_1",
    ),
  /explicit epoch classification/i,
  "Legacy deletion must reject an unclassified topology mutation before reads or writes.",
);

await assert.rejects(
  () =>
    sourceOccurrenceProvenanceRepository.reassignPreparedEventTopology(
      unreadableContext(),
      { eventId: "event_1", links: [], occurrences: [], receipts: [] },
      "event_2",
    ),
  /explicit epoch classification/i,
  "Prepared reassignment must reject an unclassified topology mutation before reads or writes.",
);

assert.equal(
  Object.hasOwn(sourceOccurrenceProvenanceRepository, "reassignEvent"),
  false,
  "The unguarded raw occurrence reassignment helper must remain module-private.",
);

const reconciliationIngressSource = readFileSync(
  "convex/reconciliationIngress.ts",
  "utf8",
);
assert.match(
  reconciliationIngressSource,
  /expectedKeys\.length === 0[\s\S]*const reconciliation = await reconcileSourceOccurrenceReceiptAndSync\([\s\S]*await refreshEventPublicationStates\([\s\S]*reconciliation\.affectedRepresentativeEventIds/u,
  "A verified empty-plan ingestion topology change must refresh every affected materialized publication row in the same transaction.",
);

for (const [path, pattern, label] of [
  [
    "convex/internal/migrations/reviewedMrakOccurrenceCorrection.ts",
    /refreshEventPublicationStates\(ctx, \[inspection\.event\._id\]\)[\s\S]*markSourceOccurrenceTopologyMutation\(ctx, \{ verified: true \}\)/u,
    "reviewed MRAK correction",
  ],
  [
    "convex/internal/migrations/reviewedMadlenianumDuplicateRewire.ts",
    /refreshEventPublicationStates\(ctx, \[[\s\S]*inspection\.duplicate\._id,[\s\S]*primaryId,[\s\S]*\]\)[\s\S]*markSourceOccurrenceTopologyMutation\(ctx, \{ verified: true \}\)/u,
    "reviewed Madlenianum rewire",
  ],
]) {
  assert.match(
    readFileSync(path, "utf8"),
    pattern,
    `The ${label} must refresh every affected publication row before advancing the verified topology frontier.`,
  );
}

console.log("Source-occurrence topology writer boundary QA passed.");
