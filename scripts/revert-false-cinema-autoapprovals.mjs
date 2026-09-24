import crypto from "node:crypto";
import { ConvexHttpClient } from "convex/browser";

const EXPECTED_SOURCE_IDENTITY = "instagram-source-identity-v1:Ddli2yVFbp3";
const EXPECTED_RECEIPT_ID = "mh75d6rya6k597g4639w2we9ss8ezydx";
const EXPECTED_IDS = Object.freeze([
  "j574fb8vtkvxv039pzvknamq458ey23a",
  "j5773jdyck0k1sp39h9y55g7g98ezd5j",
  "j5781tvm1qjdyehn625kmjvc7x8ey9x8",
  "j57c0hgkd60ksyr3g5jb63wpqs8eynp4",
]);

const argv = process.argv.slice(2);
const apply = argv.includes("--apply");
const hashIndex = argv.indexOf("--expect-plan-sha256");
const expectedHash = hashIndex >= 0 ? argv[hashIndex + 1] : undefined;
if (
  argv.some((value, index) =>
    value !== "--apply" && value !== "--expect-plan-sha256" &&
    !(index > 0 && argv[index - 1] === "--expect-plan-sha256")) ||
  (apply && !/^[0-9a-f]{64}$/u.test(expectedHash ?? "")) ||
  (!apply && expectedHash !== undefined)
) {
  throw new Error("Run a preview first; apply requires --apply --expect-plan-sha256 <preview hash>.");
}
const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL?.trim();
const serviceSecret = process.env.CRON_SECRET?.trim();
if (!convexUrl || !serviceSecret) {
  throw new Error("Missing NEXT_PUBLIC_CONVEX_URL or CRON_SECRET.");
}
const client = new ConvexHttpClient(convexUrl);
const preview = await client.query("revertFalseCinemaAutomaticApproval:preview", {
  serviceSecret,
});
if (
  preview.sourceIdentity !== EXPECTED_SOURCE_IDENTITY ||
  preview.receiptId !== EXPECTED_RECEIPT_ID ||
  preview.items.length !== EXPECTED_IDS.length ||
  new Set(preview.items.map((item) => item.id)).size !== EXPECTED_IDS.length ||
  preview.items.some((item) =>
    !EXPECTED_IDS.includes(item.id) ||
    item.title !== "I I SINOVI" ||
    !/^2026-09-(?:2[7-9]|30)$/u.test(item.date))
) {
  throw new Error("The live preview differs from the four reviewed cinema events.");
}
const plan = {
  sourceId: preview.sourceId,
  sourceUpdatedAt: preview.sourceUpdatedAt,
  receiptId: preview.receiptId,
  receiptUpdatedAt: preview.receiptUpdatedAt,
  sourceFingerprint: preview.sourceFingerprint,
  items: preview.items.map(({ title, date, ...item }) => item),
};
const planSha256 = crypto.createHash("sha256")
  .update(JSON.stringify(plan)).digest("hex");
if (!apply) {
  console.log(JSON.stringify({
    mode: "preview",
    sourceIdentity: EXPECTED_SOURCE_IDENTITY,
    receiptId: EXPECTED_RECEIPT_ID,
    candidateCount: plan.items.length,
    dates: preview.items.map((item) => item.date),
    planSha256,
  }, null, 2));
} else {
  if (planSha256 !== expectedHash) {
    throw new Error("The live reversal plan changed since preview.");
  }
  const result = await client.mutation("revertFalseCinemaAutomaticApproval:apply", {
    ...plan,
    serviceSecret,
  });
  if (
    result.updatedCount !== EXPECTED_IDS.length ||
    result.updated.some((item) => !EXPECTED_IDS.includes(item.id))
  ) {
    throw new Error("The reversal did not return all four reviewed event IDs.");
  }
  console.log(JSON.stringify({
    mode: "apply",
    updatedCount: result.updatedCount,
    eventIds: result.updated.map((item) => item.id),
    planSha256,
  }, null, 2));
}
