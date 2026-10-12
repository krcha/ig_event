/** Keep historical extraction evidence readable when the active model changes.
 * Only the approved base model names and dated snapshots are admitted; a
 * shared prefix alone does not establish extraction-model provenance. */
export function isSupportedExtractionModel(
  model: string | null | undefined,
): boolean {
  if (typeof model !== "string") return false;
  const match = /^(?:gpt-5-mini|gpt-6-luna)(?:-(\d{4}-\d{2}-\d{2}))?$/u.exec(model);
  if (!match || match[0] !== model) return false;
  if (!match[1]) return true;

  const snapshotDate = new Date(`${match[1]}T00:00:00.000Z`);
  return Number.isFinite(snapshotDate.getTime()) &&
    snapshotDate.toISOString().slice(0, 10) === match[1];
}
