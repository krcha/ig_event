export type CronIngestionCandidateSnapshot<TJob extends { handles: string[] }> = {
  resumableJob: TJob | null;
  activeHandles: string[];
};

/**
 * Resolve durable resumable work before enumerating the global source fleet.
 * A zero remaining budget must not trigger either datastore operation.
 */
export async function loadCronIngestionCandidateSnapshot<
  TJob extends { handles: string[] },
>(options: {
  resumeCapacity: number;
  findResumableJob: () => Promise<TJob | null>;
  loadActiveHandles: () => Promise<string[]>;
}): Promise<CronIngestionCandidateSnapshot<TJob>> {
  if (!Number.isFinite(options.resumeCapacity) || options.resumeCapacity <= 0) {
    return { resumableJob: null, activeHandles: [] };
  }

  const resumableJob = await options.findResumableJob();
  if (resumableJob) {
    return { resumableJob, activeHandles: [] };
  }

  return {
    resumableJob: null,
    activeHandles: await options.loadActiveHandles(),
  };
}
