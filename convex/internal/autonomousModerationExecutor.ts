import { v } from "convex/values";
import { internalAction } from "../_generated/server";

/** Host execution reuses the existing server pipeline and its service auth. */
export const advance = internalAction({
  args: {}, returns: v.object({ invoked: v.boolean(), reason: v.string() }),
  handler: async () => {
    const configured = process.env.AUTONOMOUS_MODERATION_EXECUTOR_ORIGIN?.trim();
    const secret = process.env.CRON_SECRET?.trim();
    if (!configured || !secret) return { invoked: false, reason: "executor_not_configured" };
    let origin: URL;
    try { origin = new URL(configured); } catch { return { invoked: false, reason: "invalid_executor_origin" }; }
    if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/" ||
        (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["127.0.0.1", "localhost", "web"].includes(origin.hostname)))) {
      return { invoked: false, reason: "invalid_executor_origin" };
    }
    const response = await fetch(new URL("/api/cron/autonomous-moderation", origin), {
      method: "POST", headers: { Authorization: `Bearer ${secret}` }, redirect: "error", signal: AbortSignal.timeout(240_000),
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error(`Autonomous moderation executor returned HTTP ${response.status}.`);
    return { invoked: true, reason: "executor_advanced" };
  },
});
