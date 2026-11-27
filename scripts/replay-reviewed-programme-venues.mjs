import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ConvexHttpClient } from "convex/browser";

// Preview the frozen event versions by default.
// Shared receipts change on each write, so each apply needs a fresh live plan.
const args = process.argv.slice(2);
assert(args.length === 0 || (args.length === 1 && args[0] === "--apply"), "Use --apply or omit arguments for preview.");
const applying = args[0] === "--apply";
const sources = new Map([
  ["jn7fxa6vm38nkn4kdmx47abec98k0y8s", { url: "https://www.instagram.com/p/DgNUBNBCMTR/", names: ["Bife Ipče"] }],
  ["jn7264javan5brq4nsyvwya9hn8k1ep4", { url: "https://www.instagram.com/p/DgNI6fUhajP/", names: ["Dvorana Kulturnog centra Beograda", "Likovna galerija Kulturnog centra Beograda"] }],
]);
const secret = process.env.CRON_SECRET;
const url = process.env.NEXT_PUBLIC_CONVEX_URL;
assert(secret && url, "Run with the target deployment's Convex URL and service credentials.");
const client = new ConvexHttpClient(url);
const groups = JSON.parse(await readFile(new URL("../data/reviewed-programme-venues-2026-11-27.json", import.meta.url), "utf8"));
const rows = groups.flatMap(({ events, sourcePostId, venue }) =>
  events.map(event => ({ ...event, sourcePostId, venue })));
assert(Array.isArray(rows) && rows.length > 0 && rows.length <= 32);
assert.equal(new Set(rows.map(row => row.id)).size, rows.length, "Duplicate event ID.");
for (const row of rows) {
  assert(typeof row.id === "string" && Number.isSafeInteger(row.version) && sources.get(row.sourcePostId)?.names.includes(row.venue), "Invalid reviewed row.");
}

async function check(row) {
  const visible = await client.query("events:getPublicApprovedEvent", { id: row.id });
  if (visible) {
    assert(visible.venueId && visible.venue === row.venue && visible.instagramPostUrl === sources.get(row.sourcePostId).url, "Public event differs from reviewed venue or source.");
    return null;
  }
  const { plan, venue } = await client.query("upcomingVenueRepairs:preview", {
    id: row.id, expectedUpdatedAt: row.version, serviceSecret: secret,
  });
  assert(plan.sourcePostId === row.sourcePostId && plan.expectedStatus === "approved" && venue === row.venue, "Preview has different source, status or physical venue.");
  return plan;
}

for (const row of rows) {
  const plan = await check(row);
  console.log(row.id, plan ? "ready" : "already_public", row.venue);
}
if (applying) {
  for (const row of rows) {
    const plan = await check(row);
    if (!plan) continue;
    const result = await client.mutation("upcomingVenueRepairs:apply", { plan, serviceSecret: secret });
    assert(result.id === row.id && result.publicationState === "publishable");
    assert.equal(await check(row), null, "Expected exact event on the public read path.");
    console.log(row.id, "published", row.venue);
  }
}
