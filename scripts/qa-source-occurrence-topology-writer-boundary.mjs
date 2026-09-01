import assert from "node:assert/strict";

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

console.log("Source-occurrence topology writer boundary QA passed.");
