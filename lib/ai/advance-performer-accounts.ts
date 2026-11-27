import type { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import { researchPerformerAccount } from "./research-performer-account";

const rpc = (method: string) =>
  ("performerAccountResearch:" +
    method) as unknown as FunctionReference<"mutation">;
export async function advancePerformerAccounts(
  convex: ConvexHttpClient,
  serviceSecret: string,
  owner: string,
  allowWeb: boolean,
  deadlineAt: number,
) {
  const counts = { instagram: 0, web: 0, paid: 0, written: 0, unavailable: 0 };
  const phases = [
    ...(allowWeb ? ["web"] : []),
    "instagram",
    "instagram",
    ...(allowWeb ? ["web"] : []),
  ] as const;
  for (const phase of phases) {
    if (phase === "web" && counts.web) continue;
    const remaining = deadlineAt - Date.now();
    if (remaining < 3000) break;
    const target = (await convex.mutation(rpc("claim"), {
      serviceSecret,
      owner,
      phase,
    })) as { profileId: string; knownName: string; handle: string } | null;
    if (!target) continue;
    if (phase === "web") counts.web++;
    else counts.instagram++;
    const args = {
      serviceSecret,
      owner,
      profileId: target.profileId,
      handle: target.handle,
    };
    let blocked = false;
    let unavailable = false;
    let result:
      | Awaited<ReturnType<typeof researchPerformerAccount>>
      | undefined;
    try {
      result = await researchPerformerAccount({
        handle: target.handle,
        knownName: target.knownName,
        internetSearch: phase === "web",
        signal: AbortSignal.timeout(
          Math.min(remaining, phase === "web" ? 45_000 : 9_000),
        ),
        beforeInternetSearch: async () => {
          if (
            phase !== "web" ||
            !(await convex.mutation(rpc("reserveSearch"), args))
          ) {
            blocked = true;
            throw new Error("No account search budget.");
          }
          counts.paid++;
        },
      });
    } catch {
      unavailable = !blocked;
    }
    if (unavailable) counts.unavailable++;
    const saved = (await convex.mutation(rpc("complete"), {
      ...args,
      outcome: blocked ? "budget" : unavailable ? "unavailable" : "success",
      ...(result ? { evidence: result } : {}),
    })) as { status: string };
    if (saved.status === "written") counts.written++;
  }
  return counts;
}
