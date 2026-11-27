import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { getBelgradeDayKey } from "../lib/pipeline/belgrade-day-key";
import { addDaysToDateKey } from "../lib/events/nightlife-date";

/** Rebuild one bounded, versioned per-profile rank after an announcement or clock boundary changes. */
export async function invalidateAccountRank(
  ctx: MutationCtx,
  id: Id<"performerRegistryProfiles">,
): Promise<void> {
  const p = await ctx.db.get(id);
  if (!p) return;
  const generation = (p.accountRank?.generation ?? 0) + 1;
  if (!p.instagramHandle) {
    await ctx.db.patch(id, {
      accountRank: { generation, ready: true, tier: 2, order: 0 },
      accountWork: { stage: "complete" },
      accountEvidence: undefined,
    });
    return;
  }
  const known = !!(p.accountEvidence?.genres.length || p.support.length);
  const work =
    p.accountWork?.stage === "complete" && !known ? undefined : p.accountWork;
  const now = Date.now();
  await ctx.db.patch(id, {
    accountRank: {
      generation,
      ready: false,
      tier: 2,
      order: 0,
      refreshAt: now + 15 * 60_000,
    },
    accountWork:
      known && p.accountEvidence?.displayName
        ? { stage: "complete" }
        : (work ?? { stage: "instagram" }),
  });
  await ctx.scheduler.runAfter(
    0,
    internal.performerAccountResearch.advanceRank,
    {
      id,
      generation,
      at: now,
      from: addDaysToDateKey(getBelgradeDayKey(now), -1),
      cursor: null,
      count: 0,
      urgent: false,
    },
  );
}
