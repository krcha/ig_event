/**
 * Frozen mode controls. These are deliberately not read from process.env:
 * a queued run must retain exactly the limits it was approved with.
 */
export const DURABLE_INGESTION_CONCURRENCY = 8;
export const DURABLE_INGESTION_COST_PER_PROFILE_MICROS = 10_000;
export const DURABLE_INGESTION_CANARY_SIZE = 16;
export const DURABLE_INGESTION_FULL_PROFILE_BUDGET_MICROS = 7_000_000;

export type DurableIngestionMode = "canary" | "catch_up" | "daily";

export type DurableIngestionControls = {
  resultsLimit: 1;
  daysBack?: 1;
  skipPinnedPosts: true;
  concurrency: 8;
  costPerProfileMicros: 10_000;
  budgetMicros: number;
  ignoreCheckpoint: boolean;
  ignoreCooldown: boolean;
};

export function durableControlsFor(mode: DurableIngestionMode): DurableIngestionControls {
  if (mode === "canary") {
    return {
      resultsLimit: 1,
      daysBack: 1,
      skipPinnedPosts: true,
      concurrency: DURABLE_INGESTION_CONCURRENCY,
      costPerProfileMicros: DURABLE_INGESTION_COST_PER_PROFILE_MICROS,
      budgetMicros: DURABLE_INGESTION_CANARY_SIZE * DURABLE_INGESTION_COST_PER_PROFILE_MICROS,
      ignoreCheckpoint: false,
      ignoreCooldown: false,
    };
  }
  if (mode === "catch_up") {
    return {
      resultsLimit: 1,
      skipPinnedPosts: true,
      concurrency: DURABLE_INGESTION_CONCURRENCY,
      costPerProfileMicros: DURABLE_INGESTION_COST_PER_PROFILE_MICROS,
      budgetMicros: DURABLE_INGESTION_FULL_PROFILE_BUDGET_MICROS,
      ignoreCheckpoint: true,
      ignoreCooldown: true,
    };
  }
  return {
    resultsLimit: 1,
    daysBack: 1,
    skipPinnedPosts: true,
    concurrency: DURABLE_INGESTION_CONCURRENCY,
    costPerProfileMicros: DURABLE_INGESTION_COST_PER_PROFILE_MICROS,
    budgetMicros: DURABLE_INGESTION_FULL_PROFILE_BUDGET_MICROS,
    ignoreCheckpoint: false,
    ignoreCooldown: false,
  };
}

export function selectDeterministicCanary(handles: string[]): string[] {
  const normalized = [...new Set(handles.map((value) => value.trim().replace(/^@+/, "").toLowerCase()))]
    .filter((value) => /^[a-z0-9._]{1,128}$/.test(value))
    .sort((a, b) => a.localeCompare(b));
  if (normalized.length < DURABLE_INGESTION_CANARY_SIZE) {
    throw new Error("The active source snapshot has fewer than 16 valid profiles.");
  }
  // Stable positions give each mixed lexical segment a deterministic chance,
  // and are repeatable from the frozen source snapshot.
  return Array.from({ length: DURABLE_INGESTION_CANARY_SIZE }, (_, index) =>
    normalized[Math.floor((index * normalized.length) / DURABLE_INGESTION_CANARY_SIZE)],
  );
}
