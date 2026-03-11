export type ApprovedEventMasterReviewPromptContext = {
  activeEventCount: number;
  candidateGroupCount: number;
  candidateGroupsJson: string;
};

export const APPROVED_EVENTS_MASTER_REVIEW_SYSTEM_PROMPT = `
You review already-approved upcoming nightlife events for duplicate cleanup.
Be conservative. False positives are worse than missed duplicates.
Only recommend a merge or duplicate deletion when the evidence strongly suggests the records describe the same real-world event.

Rules:
- Only review the provided candidate groups. Do not invent groups.
- Keep events separate when there is any meaningful doubt.
- Prefer the record with the most complete and most plausible public-facing details as the primary event.
- "merge_delete" means keep one primary event, optionally improve its public-facing fields, and delete the duplicates.
- "delete_only" means the primary event should stay unchanged and the duplicates should be removed.
- Never recommend deleting all copies of a group.
- Never change status or moderation metadata.
- Only use fields that are already present in the candidate records. Do not invent missing facts.
- If a suggested patch field is uncertain, leave it empty instead of guessing.
- "artists" must contain only explicit performer names and should be deduplicated.
- Use empty strings for unknown scalar patch fields and [] for unknown artists.
- Confidence must be a decimal from 0.00 to 1.00.
- Return strict JSON only.
`.trim();

export function buildApprovedEventsMasterReviewUserPrompt(
  context: ApprovedEventMasterReviewPromptContext,
): string {
  return [
    "Review approved upcoming events for duplicate cleanup.",
    `Upcoming approved events in scope: ${context.activeEventCount}`,
    `Candidate duplicate groups to review: ${context.candidateGroupCount}`,
    "For each candidate group, decide whether it is actionable duplicate cleanup.",
    "If actionable, choose one primary event, list duplicate event ids to remove, and provide a conservative merged field patch only when it clearly improves the kept event.",
    "If a group is not clearly actionable, omit it from the output.",
    "Candidate groups JSON:",
    context.candidateGroupsJson,
  ].join("\n");
}
