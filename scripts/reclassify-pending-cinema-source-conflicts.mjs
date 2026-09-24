import crypto from "node:crypto";
import { ConvexHttpClient } from "convex/browser";

const SOURCE_IDENTITY = "instagram-source-identity-v1:Ddli2yVFbp3";
const EXPECTED_RECEIPT_ID = "mh75d6rya6k597g4639w2we9ss8ezydx";
const TARGET_EVENT_IDS = Object.freeze([
  "j574fb8vtkvxv039pzvknamq458ey23a",
  "j575p3gfx5nr5sygsxwjx15es98ez5cd",
  "j5767h7cd36c9prt9yg1sxpyps8ezcs7",
  "j5773jdyck0k1sp39h9y55g7g98ezd5j",
  "j5781tvm1qjdyehn625kmjvc7x8ey9x8",
  "j579w2fas7xqvka2q7ns3txtzx8ezp75",
  "j57c0hgkd60ksyr3g5jb63wpqs8eynp4",
  "j57c21f9pw4ajrkce0stv914hd8ez9qe",
  "j57ec6tgwn05sxhqr1n9dp1wp18ez886",
  "j57esbp5agarwjcrh230fpxjmn8ez725",
]);

const apply = process.argv.includes("--apply");
const expectedShaFlag = process.argv.indexOf("--expect-plan-sha256");
const expectedPlanSha256 = expectedShaFlag >= 0
  ? process.argv[expectedShaFlag + 1]
  : undefined;
if (
  process.argv.slice(2).some((argument, index, argv) =>
    argument !== "--apply" &&
    argument !== "--expect-plan-sha256" &&
    !(index > 0 && argv[index - 1] === "--expect-plan-sha256")
  ) ||
  (apply && !/^[0-9a-f]{64}$/u.test(expectedPlanSha256 ?? "")) ||
  (!apply && expectedPlanSha256 !== undefined)
) {
  throw new Error("Use a dry run first; apply requires --apply --expect-plan-sha256 <dry-run hash>.");
}
const serviceSecret = process.env.CRON_SECRET?.trim();
const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL?.trim();
if (!serviceSecret || !convexUrl) {
  throw new Error("Missing NEXT_PUBLIC_CONVEX_URL or CRON_SECRET.");
}

const client = new ConvexHttpClient(convexUrl);
const preview = await client.query("pendingSourceConflictReclassification:preview", {
  sourceIdentity: SOURCE_IDENTITY,
  eventIds: [...TARGET_EVENT_IDS],
  serviceSecret,
});
if (
  preview.sourceIdentity !== SOURCE_IDENTITY ||
  preview.expectedReceiptId !== EXPECTED_RECEIPT_ID ||
  preview.items.length !== TARGET_EVENT_IDS.length ||
  preview.items.some((item) =>
    !TARGET_EVENT_IDS.includes(item.id) ||
    item.previousMaterialCount !== 1 ||
    item.nextBenignCount !== 1
  ) ||
  new Set(preview.items.map((item) => item.id)).size !== TARGET_EVENT_IDS.length
) {
  throw new Error("Live cinema reclassification preview differs from the ten reviewed rows.");
}
const applyItems = preview.items.map(
  ({ previousMaterialCount, nextBenignCount, ...item }) => item,
);
const plan = {
  sourceIdentity: preview.sourceIdentity,
  expectedReceiptId: preview.expectedReceiptId,
  expectedReceiptUpdatedAt: preview.expectedReceiptUpdatedAt,
  expectedSourceFingerprint: preview.expectedSourceFingerprint,
  items: applyItems,
};
const planSha256 = crypto.createHash("sha256")
  .update(JSON.stringify(plan))
  .digest("hex");
if (!apply) {
  console.log(JSON.stringify({
    mode: "preview",
    sourceIdentity: SOURCE_IDENTITY,
    receiptId: EXPECTED_RECEIPT_ID,
    candidateCount: applyItems.length,
    previousMaterialCount: 10,
    nextBenignCount: 10,
    planSha256,
  }, null, 2));
} else {
  if (expectedPlanSha256 !== planSha256) {
    throw new Error("Live cinema reclassification plan changed after preview.");
  }
  const result = await client.mutation("pendingSourceConflictReclassification:apply", {
    ...plan,
    serviceSecret,
  });
  if (result.updatedCount !== TARGET_EVENT_IDS.length) {
    throw new Error("Cinema reclassification result did not update all reviewed rows.");
  }
  console.log(JSON.stringify({
    mode: "apply",
    sourceIdentity: SOURCE_IDENTITY,
    receiptId: EXPECTED_RECEIPT_ID,
    updatedCount: result.updatedCount,
    eventIds: result.updated.map((item) => item.id),
    planSha256,
  }, null, 2));
}
