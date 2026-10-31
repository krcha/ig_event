import { fetchEventZekaPublicationContext, rememberEventZekaSelection } from './social-publication-history.mjs';
// The Code node embeds these helpers and retains the live Story recovery guards.
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

export async function publishEventZekaStories({ env, httpRequest, getStaticData, now = () => new Date(), forceDryRun = false,
  wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)) }) {

  // Generator GET/selection POST calls are read-only. Never use this for Meta writes.
  async function requestGenerator(options, label) {
    const secrets = [String(env.EVENTZEKA_CRON_SECRET || ''), String(env.EVENTZEKA_IG_ACCESS_TOKEN || ''),
      String(env.EVENTZEKA_REELS_FB_ACCESS_TOKEN || '')].filter(Boolean);
    const safeDetail = value => {
      let text = String(value || '');
      for (const secret of secrets) text = text.replaceAll(secret, '[redacted]');
      return text.replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [redacted]').replace(/[\r\n\t]/g, ' ').slice(0, 400);
    };
    const delays = [5000, 15000, 30000];
    for (let attempt = 0; attempt < 4; attempt++) {
      let response, transportError;
      try { response = await httpRequest({ ...options, timeout: 45000 }); }
      catch (error) { transportError = error; }
      const status = Number(response?.statusCode || 0);
      if (!transportError && status >= 200 && status < 300) return response;
      let detail = '';
      if (transportError) detail = safeDetail(transportError instanceof Error ? transportError.message : transportError);
      else {
        let body = response?.body;
        if (typeof body === 'string') { try { body = JSON.parse(body); } catch { /* Plain-text upstream error. */ } }
        const reason = typeof body === 'string' ? body : typeof body?.error === 'string' ? body.error :
          body?.error?.message || body?.message || '';
        detail = safeDetail(typeof reason === 'string' ? reason : '');
      }
      const retryable = Boolean(transportError) || status === 429 || (status >= 500 && status <= 599);
      if (!retryable || attempt === 3) {
        throw new Error(label + ' failed after ' + (attempt + 1) + ' attempt(s): ' +
          (transportError ? 'transport error' : 'HTTP ' + (status || 'unknown')) + (detail ? '. ' + detail : ''));
      }
      const retryAfter = Object.entries(response?.headers || {}).find(([key]) => key.toLowerCase() === 'retry-after')?.[1];
      const seconds = Number(retryAfter);
      const requested = retryAfter === undefined ? 0 : Number.isFinite(seconds) ? seconds * 1000 : Date.parse(String(retryAfter)) - Date.now();
      const delay = Math.max(delays[attempt], Math.min(30000, Math.max(0, Number.isFinite(requested) ? requested : 0)));
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  const localDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Belgrade', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now());
  if (localDate === '2026-10-25') return [{ json: { status: 'skipped_special_publication_day', publishDate: localDate,
    format: 'story', resumeDate: '2026-10-26', specialWorkflowId: 'EzekaSpecial20261025' } }];
  const origin = String(env.EVENTZEKA_API_ORIGIN || '').replace(/\/+$/, '');
  const mediaOrigin = String(env.EVENTZEKA_STORIES_PUBLIC_ORIGIN || 'https://eventzeka.com').replace(/\/+$/, '');
  const cronSecret = String(env.EVENTZEKA_CRON_SECRET || '');
  const graphBase = String(env.EVENTZEKA_IG_GRAPH_BASE_URL || 'https://graph.instagram.com').replace(/\/+$/, '');
  const graphVersion = String(env.EVENTZEKA_IG_GRAPH_VERSION || 'v25.0').replace(/^\/+|\/+$/g, '');
  const igUserId = String(env.EVENTZEKA_IG_USER_ID || '');
  const accessToken = String(env.EVENTZEKA_IG_ACCESS_TOKEN || '');
  const locationId = String(env.EVENTZEKA_STORY_LOCATION_ID || env.EVENTZEKA_IG_LOCATION_ID || '109920975697736').trim();
  const dryRun = forceDryRun || String(env.EVENTZEKA_SOCIAL_DRY_RUN || '').toLowerCase() === 'true';
  if (!origin || !cronSecret) throw new Error('Event Zeka API origin or cron secret is not configured.');
  if (!/^\d{5,30}$/.test(locationId)) throw new Error('Story location must be a numeric location Page ID.');
  const dateInBelgrade = () => {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Belgrade', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now());
    const part = type => parts.find(value => value.type === type).value;
    return `${part('year')}-${part('month')}-${part('day')}`;
  };
  const today = dateInBelgrade();
  const state = dryRun ? null : getStaticData();
  const safeError = error => {
    const message = error instanceof Error ? error.message : String(error);
    return accessToken ? message.replaceAll(accessToken, '[redacted]') : message;
  };
  const retryPending = state?.pending?.definitivelyRejected === true &&
    state.pending.publishDate === today && state.series?.publishDate === today &&
    state.series.selectionKey === state.pending.selectionKey &&
    state.series.frames?.[state.pending.frameIndex]?.containerId === state.pending.containerId;
  if (state?.pending && !retryPending) return [{ json: { status: 'blocked_reconciliation_required', publishDate: today,
    pendingDate: state.pending.publishDate, frameIndex: state.pending.frameIndex,
    containerId: state.pending.containerId, reason: state.pending.error || 'A previous Story publish has an unknown outcome.' } }];
  if (state?.lastPublishDate === today) return [{ json: { status: 'skipped_already_published', publishDate: today, storyIds: state.lastStoryIds || [] } }];

  function parseBody(body) {
    if (body && typeof body === 'object') return body;
    try { return JSON.parse(body || '{}'); } catch { return {}; }
  }
  let payload = !dryRun && state.series?.publishDate === today ? state.series : null;
  if (!payload) {
    const previewDate = dryRun ? String(env.EVENTZEKA_STORY_PREVIEW_DATE || '') : '';
    if (previewDate && !/^\d{4}-\d{2}-\d{2}$/.test(previewDate)) throw new Error('Invalid Story preview date.');
    const previewHistory = String(env.EVENTZEKA_SOCIAL_PREVIEW_HISTORY || '').toLowerCase() === 'true';
    const context = (!dryRun || previewHistory) && igUserId && accessToken
      ? await fetchEventZekaPublicationContext({ httpRequest, graphBase, graphVersion, accessToken, userId: igUserId, today, state: state || {} }) : null;
    const response = await requestGenerator({ method: context ? 'POST' : 'GET', url: `${origin}/api/social/daily-stories${previewDate ? `?date=${encodeURIComponent(previewDate)}` : ''}`,
      headers: { Authorization: `Bearer ${cronSecret}`, Accept: 'application/json', ...(context ? { 'Content-Type': 'application/json' } : {}) },
      body: context ? JSON.stringify(context) : undefined, returnFullResponse: true, ignoreHttpStatusErrors: true }, 'Story generator');
    const status = Number(response.statusCode || 0);
    payload = parseBody(response.body);
    if (status < 200 || status >= 300) throw new Error(`Story generator failed: HTTP ${status || 'unknown'}.`);
  }
  if (!dryRun && payload.publishDate !== today) throw new Error('Story generator returned a different Belgrade date.');
  if (!Number.isInteger(payload.selectedCount) || !Array.isArray(payload.frames)) throw new Error('Invalid Story payload.');
  if (payload.selectedCount === 0 && payload.frames.length === 0) return [{ json: { status: 'skipped_no_events', publishDate: payload.publishDate, selectedCount: 0 } }];
  const [agenda] = payload.frames;
  const videoQuery = typeof agenda.videoUrl === 'string' ? agenda.videoUrl.split('?')[1]?.split('&') || [] : [];
  if (payload.selectionPolicy !== 'prefer_unposted' || !Array.isArray(payload.repeatedEventIds) || !payload.selectionKey || !/^\d{4}-\d{2}-\d{2}$/.test(payload.publishDate || '') || payload.frames.length !== 1 ||
    payload.selectedCount < 1 || payload.selectedCount > 4 || payload.durationSeconds !== 18 || payload.hasClosingCta !== true || agenda.kind !== 'agenda' ||
    agenda.date !== payload.publishDate ||
    !Array.isArray(agenda.eventIds) || agenda.eventIds.length !== payload.selectedCount || new Set(agenda.eventIds).size !== agenda.eventIds.length ||
    agenda.mediaType !== 'VIDEO' || agenda.durationSeconds !== 18 || agenda.hasClosingCta !== true ||
    typeof agenda.videoUrl !== 'string' || !agenda.videoUrl.startsWith(`${mediaOrigin}/api/social/stories/days/${payload.publishDate}?`) ||
    !/[?&]v=s5-[a-z0-9]+(?:&|$)/.test(agenda.videoUrl) || videoQuery.filter(value => value.startsWith('publishDate=')).length !== 1 ||
    !videoQuery.includes(`publishDate=${payload.publishDate}`) || /[?&]cover=/.test(agenda.videoUrl) ||
    agenda.imageUrl !== `${agenda.videoUrl}&cover=1`) {
    throw new Error('Stories require exactly one current-day DANAS video with an 18-second closing CTA.');
  }
  const userTags = agenda.userTags === undefined ? [] : agenda.userTags;
  if (!Array.isArray(userTags) || userTags.length > payload.selectedCount || new Set(userTags.map(tag => tag?.username)).size !== userTags.length ||
    userTags.some(tag => !tag || !/^[a-z0-9_][a-z0-9_.]{0,29}$/.test(tag.username || '') ||
      !Number.isFinite(tag.x) || !Number.isFinite(tag.y) || tag.x < 0 || tag.x > 1 || tag.y < 0 || tag.y > 1)) {
    throw new Error('Invalid Story venue tags.');
  }
  const preview = { design: payload.design || null, publishDate: payload.publishDate, selectionKey: payload.selectionKey, selectedCount: payload.selectedCount,
    repeatedEventIds: payload.repeatedEventIds, frameCount: payload.frames.length, previewUrls: payload.frames.map(frame => frame.imageUrl),
    videoUrls: payload.frames.map(frame => frame.videoUrl), mediaType: 'VIDEO', durationSeconds: 18, hasClosingCta: true,
    venueTags: userTags.map(tag => `@${tag.username}`), locationId, locationName: 'Belgrade, Serbia', locationSticker: false };
  if (!dryRun && (!igUserId || !accessToken)) return [{ json: { status: 'blocked_meta_authorization_required', ...preview } }];
  for (const frame of payload.frames.filter(frame => dryRun || !frame.postId)) {
    const video = await httpRequest({ method: 'HEAD', url: frame.videoUrl, returnFullResponse: true, ignoreHttpStatusErrors: true, timeout: 420000 });
    const videoType = String(video.headers?.['content-type'] || video.headers?.['Content-Type'] || '');
    const ranges = String(video.headers?.['accept-ranges'] || video.headers?.['Accept-Ranges'] || '');
    if (Number(video.statusCode) !== 200 || !/^video\/mp4(?:;|$)/i.test(videoType) || !/^bytes$/i.test(ranges)) {
      throw new Error('Story video preflight failed. The exact saved MP4 and byte ranges must be verified before publishing.');
    }
    const range = await httpRequest({ method: 'GET', url: frame.videoUrl, headers: { Range: 'bytes=0-31' },
      encoding: 'arraybuffer', returnFullResponse: true, ignoreHttpStatusErrors: true, timeout: 420000 });
    if (Number(range.statusCode) !== 206 || !/^bytes 0-31\/[1-9]\d*$/i.test(String(range.headers?.['content-range'] || range.headers?.['Content-Range'] || '')) ||
      !/^video\/mp4(?:;|$)/i.test(String(range.headers?.['content-type'] || range.headers?.['Content-Type'] || ''))) {
      throw new Error('Story video byte-range preflight failed.');
    }
    const image = await httpRequest({ method: 'HEAD', url: frame.imageUrl, returnFullResponse: true, ignoreHttpStatusErrors: true, timeout: 420000 });
    if (Number(image.statusCode) !== 200 || !/^image\/jpeg(?:;|$)/i.test(String(image.headers?.['content-type'] || image.headers?.['Content-Type'] || ''))) {
      throw new Error('Story image preflight failed. The exact saved image must be verified before publishing.');
    }
  }
  if (dryRun) return [{ json: { status: 'dry_run', ...preview } }];

  const graphUrl = path => [graphBase, graphVersion, path.replace(/^\/+/, '')].filter(Boolean).join('/');
  async function graphRequest(path, options = {}) {
    const attempts = options.singleAttempt ? 1 : 3;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const body = options.body ? Object.entries(options.body).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`).join('&') : undefined;
        const response = await httpRequest({ method: options.body ? 'POST' : 'GET', url: graphUrl(path),
          headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
          body, returnFullResponse: true, ignoreHttpStatusErrors: true });
        const status = Number(response.statusCode || 0);
        const data = parseBody(response.body);
        if (status >= 200 && status < 300) return data;
        const error = new Error(`Instagram Story request failed: ${data.error?.message || `HTTP ${status || 'unknown'}`} (HTTP ${status}, code ${data.error?.code || 0}, subcode ${data.error?.error_subcode || 0}).`);
        error.httpStatus = status;
        error.metaCode = data.error?.code;
        error.metaSubcode = data.error?.error_subcode;
        error.retryable = status === 429 || status >= 500;
        throw error;
      } catch (error) {
        if (error.retryable === false || attempt === attempts) {
          error.message = safeError(error);
          throw error;
        }
        await wait(attempt * 3000);
      }
    }
  }
  async function waitForContainer(id) {
    for (let attempt = 0; attempt < 36; attempt += 1) {
      const result = await graphRequest(`${id}?fields=status_code,status`);
      if (result.status_code === 'FINISHED') return;
      if (result.status_code === 'ERROR' || result.status_code === 'EXPIRED') throw new Error(`Story container ended with ${result.status_code}.`);
      await wait(5000);
    }
    throw new Error('Story container did not finish within 180 seconds.');
  }
  if (await hasPublishedInstagramStoryToday({ graphRequest, userId: igUserId, today })) {
    return [{ json: { status: 'blocked_reconciliation_required', ...preview,
      reason: 'Instagram already has a current-day Story without a matching local publication receipt.' } }];
  }
  const series = { ...payload, locationId: payload.locationId || locationId,
    frames: payload.frames.map(frame => ({ ...frame, eventIds: [...frame.eventIds], userTags: (frame.userTags || []).map(tag => ({ ...tag })) })) };
  if (series.locationId !== locationId) throw new Error('The saved Story location changed. Reconcile its prepared container before continuing.');
  // Prepare the exact DANAS video, including its CTA, before publication.
  for (const frame of series.frames.filter(frame => !frame.postId)) {
    if (!frame.containerId) {
      const body = { media_type: 'STORIES', video_url: frame.videoUrl, location_id: series.locationId };
      if (frame.userTags.length) body.user_tags = JSON.stringify(frame.userTags);
      const created = await graphRequest(`${igUserId}/media`, { body });
      if (!created.id) throw new Error('Instagram did not return a Story container ID.');
      frame.containerId = created.id;
    }
    await waitForContainer(frame.containerId);
  }
  if ((state.pending && !retryPending) || state.lastPublishDate === today) return [{ json: { status: 'blocked_reconciliation_required', ...preview, reason: 'Story publication state changed during preparation.' } }];
  if (state.series && state.series.publishDate !== today) {
    state.lastIncompleteSeries = { publishDate: state.series.publishDate, selectionKey: state.series.selectionKey,
      storyIds: state.series.frames.filter(frame => frame.postId).map(frame => frame.postId) };
  }
  state.series = series;
  for (const [index, frame] of series.frames.entries()) {
    if (frame.postId) continue;
    if (dateInBelgrade() !== series.publishDate) return [{ json: { status: 'blocked_stale_date', ...preview } }];
    if (state.pending && !retryPending) return [{ json: { status: 'blocked_reconciliation_required', ...preview, reason: 'Another Story publish is unresolved.' } }];
    state.pending = { publishDate: series.publishDate, selectionKey: series.selectionKey, frameIndex: index,
      containerId: frame.containerId, startedAt: now().toISOString() };
    let result;
    try {
      result = await publishPreparedInstagramStory({ graphRequest, userId: igUserId,
        containerId: frame.containerId, wait });
    } catch (error) {
      state.pending.error = safeError(error);
      state.pending.definitivelyRejected = error.httpStatus === 400 &&
        ((error.metaCode === 24 && error.metaSubcode === 2207008) ||
         (error.metaCode === 9007 && error.metaSubcode === 2207027));
      return [{ json: { status: 'blocked_reconciliation_required', ...preview, frameIndex: index,
        containerId: frame.containerId, storyIds: series.frames.filter(item => item.postId).map(item => item.postId), reason: state.pending.error } }];
    }
    frame.postId = result.id;
    frame.publishedAt = now().toISOString();
    delete state.pending;
  }
  state.lastPublishDate = series.publishDate;
  state.lastSelectionKey = series.selectionKey;
  state.lastStoryIds = series.frames.map(frame => frame.postId);
  state.lastPublishedAt = now().toISOString();
  rememberEventZekaSelection(state, series);
  delete state.series;
  return [{ json: { status: 'published', ...preview, storyIds: state.lastStoryIds } }];
}
