import type { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import type { InstagramFollowerObservation } from "@/lib/venues/instagram-follower-observation";

const recordFollowerCounts = "venues:recordInstagramFollowerCounts" as unknown as FunctionReference<"mutation">;

/** Profile metadata is independent of the post and provider-attempt receipts. */
export async function persistInstagramFollowerObservations(
  client: ConvexHttpClient,
  observations: readonly InstagramFollowerObservation[],
  serviceSecret: string,
) {
  const newestByHandle = new Map<string, InstagramFollowerObservation | null>();
  for (const observation of [...observations].sort((left, right) => right.observedAt - left.observedAt)) {
    const existing = newestByHandle.get(observation.handle);
    if (existing === undefined) newestByHandle.set(observation.handle, observation);
    else if (existing && existing.observedAt === observation.observedAt && existing.count !== observation.count) {
      newestByHandle.set(observation.handle, null);
    }
  }
  const rows = [...newestByHandle.values()].filter((row) => row !== null);
  for (let offset = 0; offset < rows.length; offset += 50) {
    try {
      await client.mutation(recordFollowerCounts, { observations: rows.slice(offset, offset + 50), serviceSecret });
    } catch {
      console.warn(JSON.stringify({ level: "warn", event: "ingestion.instagram.follower_counts_write_failed" }));
    }
  }
}
