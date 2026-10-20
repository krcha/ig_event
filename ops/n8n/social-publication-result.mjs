// Preserve the live Code-node failure surface for blocked publication outcomes.
export function assertSocialPublicationResult(result) {
  const allowed = new Set(['published', 'dry_run', 'skipped_already_published',
    'skipped_no_events', 'skipped_special_publication_day',
    'skipped_before_special_time', 'skipped_outside_special_date']);
  if (!Array.isArray(result) || !result.length) throw new Error('Publication returned no result.');
  for (const item of result) {
    const output = item?.json;
    if (!output || !allowed.has(output.status)) {
      throw new Error(`Social publication failed (${output?.status || 'missing_status'}): ${output?.reason || 'Publication needs reconciliation.'}`);
    }
  }
  return result;
}
