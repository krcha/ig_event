// A publish retry must use the identical container, and only follow an explicit
// temporary rejection. Never retry an unknown transport or accepted outcome.
export async function publishPreparedInstagramStory({ graphRequest, userId, containerId, wait }) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const container = await graphRequest(`${containerId}?fields=status_code,status`);
    if (container.status_code !== 'FINISHED') {
      throw new Error(`Story publish requires reconciliation: container is ${container.status_code || 'unknown'}.`);
    }
    try {
      const result = await graphRequest(`${userId}/media_publish`, {
        body: { creation_id: containerId }, singleAttempt: true,
      });
      if (!result.id) throw new Error('Instagram did not return a published Story ID.');
      return result;
    } catch (error) {
      const temporaryRejection = error.httpStatus === 400 &&
        ((error.metaCode === 24 && error.metaSubcode === 2207008) ||
         (error.metaCode === 9007 && error.metaSubcode === 2207027));
      if (!temporaryRejection || attempt === 2) throw error;
      await wait((attempt + 1) * 30_000);
    }
  }
}

// Static data may be lost in a host crash after Instagram accepted a publish.
// An existing current-day Story therefore blocks creating/publishing any new
// one until its receipt is reconciled, even when local state is empty.
export async function hasPublishedInstagramStoryToday({ graphRequest, userId, today }) {
  let after = '';
  const seen = new Set();
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Belgrade',
    year: 'numeric', month: '2-digit', day: '2-digit' });
  for (let page = 0; page < 10; page += 1) {
    const result = await graphRequest(`${userId}/stories?fields=id,timestamp&limit=50${after ? `&after=${encodeURIComponent(after)}` : ''}`);
    if (!Array.isArray(result.data)) throw new Error('Could not verify active Instagram Stories.');
    for (const story of result.data) {
      const timestamp = Date.parse(story.timestamp);
      if (!story.id || !Number.isFinite(timestamp)) throw new Error('Invalid active Instagram Story receipt.');
      if (formatter.format(new Date(timestamp)) === today) return true;
    }
    if (!result.paging?.next) return false;
    after = result.paging?.cursors?.after;
    if (!after || seen.has(after)) throw new Error('Could not completely verify active Instagram Stories.');
    seen.add(after);
  }
  throw new Error('Active Instagram Story verification exceeded its page limit.');
}
