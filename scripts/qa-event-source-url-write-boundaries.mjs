import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { requireCanonicalInstagramPostUrl } from "../convex/eventDomain/sourceUrlPolicy.ts";

for (const value of [
  "https://instagram.com/reel/Ab_C-91/?igsh=tracking",
  "http://m.instagram.com/tv/Ab_C-91/#poster",
]) {
  assert.equal(
    requireCanonicalInstagramPostUrl(value, "QA write boundary"),
    "https://www.instagram.com/p/Ab_C-91/",
  );
}

for (const value of [
  "",
  "https://www.instagram.com/eventzeka/",
  "https://www.instagram.com/p/Ab_C-91/comments/",
  "https://user:secret@www.instagram.com/p/Ab_C-91/",
  "https://www.instagram.com:8443/p/Ab_C-91/",
]) {
  assert.throws(
    () => requireCanonicalInstagramPostUrl(value, "QA write boundary"),
    (error) => error?.code === "SOURCE_URL_INVALID",
    `${value || "<empty>"} must fail the event write boundary`,
  );
}

const writeModules = [
  "convex/eventDomain/eventCreation.ts",
  "convex/eventDomain/eventUpdates.ts",
  "convex/eventDomain/lifecycleCommands.ts",
  "convex/eventDomain/moderationCommands.ts",
  "convex/eventDomain/nightlifeLineup.ts",
  "convex/internal/eventRepairs/approvedLegacyVenue.ts",
  "convex/internal/eventRepairs/evidencePolicy.ts",
  "convex/internal/eventRepairs/reviewedContinuationFold.ts",
  "convex/internal/eventRepairs/reviewedPromotionFold.ts",
  "convex/internal/eventRepairs/reviewedScheduleFold.ts",
  "convex/internal/eventRepairs/reviewedStructuredCorrections.ts",
  "convex/internal/eventRepairs/sourceGroundingReprocess.ts",
  "convex/internal/eventRepairs/trustedV2VenueRepair.ts",
];

for (const filePath of writeModules) {
  const source = await readFile(
    new URL(`../${filePath}`, import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /requireCanonicalInstagramPostUrl/u,
    `${filePath} must enforce canonical source identity before writing`,
  );
  assert.doesNotMatch(
    source,
    /normalizeInstagramPostUrl/u,
    `${filePath} must not use compatibility normalization as write authority`,
  );
}

const crossPostSource = await readFile(
  new URL("../convex/eventDomain/crossPostPromotion.ts", import.meta.url),
  "utf8",
);
const crossPostMutationSource = crossPostSource.slice(
  crossPostSource.indexOf(
    "export async function coalesceApprovedCrossPostPromotionOccurrencesHandler",
  ),
);
assert.match(crossPostMutationSource, /requireCanonicalInstagramPostUrl/u);
assert.doesNotMatch(crossPostMutationSource, /normalizeInstagramPostUrl/u);

assert.match(
  await readFile(
    new URL("../convex/eventDomain/nightlifeLineup.ts", import.meta.url),
    "utf8",
  ),
  /MAX_SAVED_REFERENCES_PER_EVENT_OPERATION/u,
  "Nightlife folding must use the repository's combined physical-row cap.",
);

console.log(
  "Event source URL write-boundary QA passed: approvals, repairs, folds, coalescing, creation, and updates fail closed through the central canonicalizer.",
);
