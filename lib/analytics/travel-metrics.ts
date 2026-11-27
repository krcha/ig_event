export const travelStages = ["places", "programmes", "reference", "recommendations"] as const;
export type TravelStage = typeof travelStages[number];
export type TravelMeasurement = { kind: "travel"; stage: TravelStage; outcome: "ready"; ms: number }
  | { kind: "travel"; stage: TravelStage; outcome: "error" | "retry" };

export const TRAVEL_BUCKET_MS = 250;
export const TRAVEL_LAST_MS = 120_000;

export function isTravelMeasurement(value: unknown): value is TravelMeasurement {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<TravelMeasurement> & { ms?: number };
  if (row.kind !== "travel" || !travelStages.includes(row.stage as TravelStage)) return false;
  if (row.outcome === "ready") return Object.keys(row).length === 4 && Number.isSafeInteger(row.ms) && row.ms! >= 0;
  return (row.outcome === "error" || row.outcome === "retry") && Object.keys(row).length === 3;
}

type DayCounts = { stage: TravelStage; buckets: number[]; errors: number; retries: number };
export function addTravelTiming(buckets: number[], ms: number) {
  const index = Math.min(Math.ceil(ms / TRAVEL_BUCKET_MS), TRAVEL_LAST_MS / TRAVEL_BUCKET_MS + 1);
  const counts = [...buckets];
  while (counts.length <= index) counts.push(0);
  counts[index]++;
  return counts;
}

export function summarizeTravelTimings(days: DayCounts[]) {
  return travelStages.map(stage => {
    const counts: number[] = [];
    let errors = 0, retries = 0, samples = 0;
    for (const row of days) {
      if (row.stage !== stage) continue;
      errors += row.errors;
      retries += row.retries;
      row.buckets.forEach((n, i) => { counts[i] = (counts[i] ?? 0) + n; samples += n; });
    }
    const rank = Math.ceil(samples * 0.75);
    let cumulative = 0;
    const index = counts.findIndex(n => { cumulative += n; return cumulative >= rank; });
    const overflow = index * TRAVEL_BUCKET_MS > TRAVEL_LAST_MS;
    return { stage, samples, errors, retries, p75Ms: index < 0 || overflow ? null : index * TRAVEL_BUCKET_MS, overflow };
  });
}
