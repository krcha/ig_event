import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction } from "../_generated/server";

export const advance = internalAction({
  args: {},
  returns: v.object({ invoked: v.boolean(), reason: v.string() }),
  handler: async (ctx) => {
    await ctx.runMutation(internal.performerAccountResearch.prepare,{});
    const configured = process.env.EVENT_DISCOVERY_EXECUTOR_ORIGIN?.trim() ||
      process.env.AUTONOMOUS_MODERATION_EXECUTOR_ORIGIN?.trim();
    const secret = process.env.CRON_SECRET?.trim();
    if (!configured || !secret) return { invoked: false, reason: "executor_not_configured" };
    let origin: URL;
    try { origin = new URL(configured); } catch { return { invoked: false, reason: "invalid_executor_origin" }; }
    if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/" ||
      (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["127.0.0.1", "localhost", "web"].includes(origin.hostname)))) {
      return { invoked: false, reason: "invalid_executor_origin" };
    }
    const response = await fetch(new URL("/api/cron/event-discovery", origin), {
      method: "POST", headers: { Authorization: `Bearer ${secret}` }, redirect: "error", signal: AbortSignal.timeout(240_000),
    });
    await response.body?.cancel();
    if (response.status === 409) return { invoked: true, reason: "executor_busy" };
    if (!response.ok) throw new Error(`Event discovery executor returned HTTP ${response.status}.`);
    return { invoked: true, reason: "executor_advanced" };
  },
});
