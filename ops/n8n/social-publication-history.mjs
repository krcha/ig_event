// These declarations are embedded with each publisher; no external modules are
// required in the n8n Code sandbox. Media includes Reels even off the feed grid.
export async function fetchEventZekaPublicationContext({ httpRequest, graphBase, graphVersion, accessToken, userId, today, state = {} }) {
  const since = new Date(`${today}T00:00:00Z`);
  since.setUTCDate(since.getUTCDate() - 30);
  const cutoff = since.getTime();
  const captions = []; const cursors = new Set();
  let after = '', complete = false;
  for (let page = 0; page < 10; page++) {
    let response;
    try {
      response = await httpRequest({ method: 'GET',
        url: `${graphBase}/${graphVersion}/${userId}/media?fields=caption,timestamp&limit=50${after ? `&after=${encodeURIComponent(after)}` : ''}`,
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
        returnFullResponse: true, ignoreHttpStatusErrors: true, timeout: 45000 });
    } catch { throw new Error('Could not verify recent publication history.'); }
    let data;
    try { data = typeof response.body === 'object' && response.body ? response.body : JSON.parse(response.body || '{}'); }
    catch { throw new Error('Could not verify recent publication history.'); }
    if (Number(response.statusCode) !== 200 || !Array.isArray(data.data)) throw new Error('Could not verify recent publication history.');
    for (const media of data.data) {
      const timestamp = Date.parse(media.timestamp);
      if (!Number.isFinite(timestamp)) throw new Error('Publication history has an invalid timestamp.');
      if (timestamp >= cutoff && typeof media.caption === 'string') {
        if (media.caption.length > 2200) throw new Error('Publication history has an invalid caption.');
        captions.push(media.caption);
      }
    }
    if (!data.paging?.next || (data.data.length > 0 && data.data.every(media => Date.parse(media.timestamp) < cutoff))) { complete = true; break; }
    const cursor = data.paging?.cursors?.after;
    if (!cursor || cursors.has(cursor) || !data.data.length) throw new Error('Incomplete recent publication history.');
    cursors.add(cursor); after = cursor;
  }
  if (!complete) throw new Error('Incomplete recent publication history.');
  const ids = new Set();
  const add = value => { if (typeof value === 'string' && /^[a-z0-9]{10,64}$/.test(value)) ids.add(value); };
  for (const id of state.lastEventIds || []) add(id);
  for (const item of state.publicationSelections || []) for (const id of item.eventIds || []) add(id);
  for (const key of [state.lastSelectionKey, ...(state.previousPublications || []).map(item => item.lastSelectionKey)]) {
    for (const id of String(key || '').match(/[a-z0-9]{10,64}/g) || []) add(id);
  }
  return { publishedCaptions: [...new Set(captions)], previouslyPublishedEventIds: [...ids].slice(-1000), excludedEventIds: [] };
}

export function rememberEventZekaSelection(state, payload) {
  const eventIds = payload.eventIds || (payload.slides || []).flatMap(slide => slide.eventIds || []) || [];
  const ids = eventIds.length ? eventIds : (payload.frames || []).flatMap(frame => frame.eventIds || []);
  state.lastEventIds = [...ids];
  state.publicationSelections = [...(state.publicationSelections || []).filter(item => item.selectionKey !== payload.selectionKey),
    { publishDate: payload.publishDate, selectionKey: payload.selectionKey, eventIds: [...ids], ...(payload.design ? { design: payload.design } : {}) }].slice(-31);
}
