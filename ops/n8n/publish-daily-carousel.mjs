import { fetchEventZekaPublicationContext, rememberEventZekaSelection } from './social-publication-history.mjs';
// The generator embeds this function and its history helpers in the Code node.
export async function publishEventZekaCarousel({ env, httpRequest, getStaticData, forceDryRun = false, now = () => new Date() }) {

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
  // A dated exception must not touch pending receipts or make publishing calls.
  if (localDate === '2026-10-25') return [{ json: { status: 'skipped_special_publication_day', publishDate: localDate,
    format: 'carousel', resumeDate: '2026-10-26', specialWorkflowId: 'EzekaSpecial20261025' } }];
  const origin = String(env.EVENTZEKA_API_ORIGIN || '').replace(/\/+$/, '');
  const cronSecret = String(env.EVENTZEKA_CRON_SECRET || '');
  const graphBase = String(env.EVENTZEKA_IG_GRAPH_BASE_URL || 'https://graph.instagram.com').replace(/\/+$/, '');
  const graphVersion = String(env.EVENTZEKA_IG_GRAPH_VERSION || 'v25.0').replace(/^\/+|\/+$/g, '');
  const igUserId = String(env.EVENTZEKA_IG_USER_ID || '');
  const accessToken = String(env.EVENTZEKA_IG_ACCESS_TOKEN || '');
  const locationId = String(env.EVENTZEKA_IG_LOCATION_ID || '109920975697736').trim();
  if (!origin || !cronSecret) throw new Error('Event Zeka API origin or cron secret is not configured.');
  if (!/^\d{5,30}$/.test(locationId)) throw new Error('The Instagram carousel location must be a numeric location Page ID.');

  function parseJsonBody(body) {
    if (body && typeof body === 'object') return body;
    try { return body ? JSON.parse(String(body)) : {}; } catch { return {}; }
  }
  const dryRun = forceDryRun || String(env.EVENTZEKA_SOCIAL_DRY_RUN || '').toLowerCase() === 'true';
  const state = dryRun ? null : getStaticData();
  // Catch-up runs must stop at the saved receipt before selecting or requesting media.
  if (state?.lastPublishDate === localDate && !state?.pendingSelectionKey) {
    return [{ json: { status: 'skipped_already_published', publishDate: localDate,
      selectionKey: state.lastSelectionKey || null, postId: state.lastPostId || null } }];
  }
  const previewHistory = String(env.EVENTZEKA_SOCIAL_PREVIEW_HISTORY || '').toLowerCase() === 'true';
  const response = await requestGenerator({
    method: 'GET', url: `${origin}/api/social/daily-carousel`,
    headers: { Authorization: `Bearer ${cronSecret}`, Accept: 'application/json' },
    returnFullResponse: true, ignoreHttpStatusErrors: true,
  }, 'Carousel generator');
  const status = Number(response.statusCode || 0);
  let payload = parseJsonBody(response.body);
  if (status < 200 || status >= 300) throw new Error(`Carousel generator failed: ${payload.error || `HTTP ${status || 'unknown'}`}`);
  if (!payload.selectedCount || !Array.isArray(payload.slides) || !payload.slides.length) {
    return [{ json: { status: 'skipped_no_events', publishDate: payload.publishDate, selectedCount: 0 } }];
  }
  if ((!dryRun || previewHistory) && !state?.pendingSelectionKey && state?.lastPublishDate !== payload.publishDate && igUserId && accessToken) {
    const context = await fetchEventZekaPublicationContext({ httpRequest, graphBase, graphVersion, accessToken, userId: igUserId,
      today: payload.publishDate, state: state || {} });
    const generated = await requestGenerator({ method: 'POST', url: `${origin}/api/social/daily-carousel`,
      headers: { Authorization: `Bearer ${cronSecret}`, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(context), returnFullResponse: true, ignoreHttpStatusErrors: true }, 'Carousel history selection');
    if (Number(generated.statusCode) !== 200) throw new Error('Carousel history selection failed.');
    payload = parseJsonBody(generated.body);
  }
  if (!payload.selectedCount || !Array.isArray(payload.slides) || !payload.slides.length) {
    return [{ json: { status: 'skipped_no_events', publishDate: payload.publishDate, selectedCount: 0 } }];
  }
  const agendaSlides = payload.slides.slice(0, -1);
  const closingSlide = payload.slides[payload.slides.length - 1];
  if (payload.selectionPolicy !== 'prefer_unposted' || !Array.isArray(payload.repeatedEventIds) || !payload.selectionKey || !payload.publishDate || payload.slides.length < 2 || payload.slides.length > 4 ||
      agendaSlides.some(slide => slide.kind !== 'agenda' || !slide.imageUrl || !Array.isArray(slide.eventIds) || slide.eventIds.length < 1 || slide.eventIds.length > 3) ||
      closingSlide.kind !== 'cta' || !closingSlide.imageUrl || !Array.isArray(closingSlide.userTags) || closingSlide.userTags.length) {
    throw new Error('Invalid agenda payload: one to three day pages and a final closing card are required.');
  }
  const preview = {
    design: payload.design || null,
    publishDate: payload.publishDate, selectionKey: payload.selectionKey,
    selectedCount: payload.selectedCount, slideCount: payload.slides.length,
    eventDates: payload.eventDates,
    repeatedEventIds: payload.repeatedEventIds,
    locationId, locationName: 'Belgrade, Serbia',
    previewUrls: payload.slides.map(slide => slide.imageUrl),
    venues: [...new Set(payload.slides.flatMap(slide => (slide.userTags || []).map(tag => `@${tag.username}`)))],
  };
  // An unresolved publish is blocked across dates and changed selections.
  if (state?.pendingSelectionKey) {
    return [{ json: { status: 'blocked_reconciliation_required', ...preview,
      pendingSelectionKey: state.pendingSelectionKey,
      carouselContainerId: state.pendingCarouselId || null,
      publishStartedAt: state.pendingPublishStartedAt || null,
      reason: state.pendingPublishError || 'A previous publish attempt has unknown state.' } }];
  }
  // Metadata or selection changes must not create a second daily feed post.
  if (state && (state.lastPublishDate === payload.publishDate || state.lastSelectionKey === payload.selectionKey)) {
    return [{ json: { status: 'skipped_already_published', publishDate: payload.publishDate,
      selectionKey: payload.selectionKey, postId: state.lastPostId || null } }];
  }
  if (!dryRun && (!igUserId || !accessToken)) {
    return [{ json: { status: 'blocked_meta_authorization_required', ...preview } }];
  }
  // Check every exact, versioned image before creating any Meta media containers.
  for (const slide of payload.slides) {
    const image = await httpRequest({ method: 'HEAD', url: slide.imageUrl,
      returnFullResponse: true, ignoreHttpStatusErrors: true });
    const imageStatus = Number(image.statusCode || 0);
    const imageType = String(image.headers?.['content-type'] || image.headers?.['Content-Type'] || '');
    if (imageStatus < 200 || imageStatus >= 300 || !/^image\/jpeg(?:;|$)/i.test(imageType)) {
      throw new Error(`Agenda image preflight failed: HTTP ${imageStatus || 'unknown'}. Regenerate the payload before retrying.`);
    }
  }
  if (dryRun) return [{ json: { status: 'dry_run', ...preview, caption: payload.caption } }];

  const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  const graphUrl = path => [graphBase, graphVersion, path.replace(/^\/+/, '')].filter(Boolean).join('/');
  const safeGraphText = (value, limit = 300) => {
    let message = typeof value === 'string' ? value : String(value ?? '');
    for (const secret of [accessToken, cronSecret, String(env.EVENTZEKA_REELS_FB_ACCESS_TOKEN || '')]) {
      if (secret) message = message.replaceAll(secret, '[redacted]');
    }
    return message.replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [redacted]').replace(/[\r\n\t]/g, ' ').slice(0, limit);
  };
  async function graphRequest(path, options = {}) {
    const graphStage = options.body?.creation_id ? 'media_publish' :
      options.body?.media_type === 'CAROUSEL' ? 'carousel_parent_create' :
      options.body?.is_carousel_item ? 'carousel_child_image_create' : 'graph_read';
    const graphContext = graphStage === 'carousel_child_image_create' ? safeGraphText(options.body.image_url, 300) :
      graphStage === 'carousel_parent_create' ? safeGraphText(options.body.children, 160) :
      graphStage === 'media_publish' ? safeGraphText(options.body.creation_id, 80) : '';
    const maxAttempts = Math.max(1, Number(options.maxAttempts || 3));
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const body = options.body ? Object.entries(options.body)
          .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`).join('&') : undefined;
        const graphResponse = await httpRequest({ method: options.method || 'GET', url: graphUrl(path),
          headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json',
            ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
          body, returnFullResponse: true, ignoreHttpStatusErrors: true });
        const graphStatus = Number(graphResponse.statusCode || 0);
        const data = parseJsonBody(graphResponse.body);
        if (graphStatus >= 200 && graphStatus < 300) return data;
        const message = safeGraphText(data?.error?.message || data?.error?.error_user_msg || ('HTTP ' + (graphStatus || 'unknown')));
        const numeric = value => Number.isSafeInteger(Number(value)) ? Number(value) : 0;
        const metaCode = numeric(data?.error?.code), metaSubcode = numeric(data?.error?.error_subcode);
        const trace = safeGraphText(data?.error?.fbtrace_id || graphResponse.headers?.['x-fb-trace-id'] || graphResponse.headers?.['X-FB-Trace-ID'] || '', 100);
        const userMessage = safeGraphText(data?.error?.error_user_msg || '');
        lastError = new Error('Instagram Graph request failed for ' + safeGraphText(path, 160) + ' [' + graphStage + (graphContext ? ': ' + graphContext : '') + ']: ' + message +
          ' (HTTP ' + numeric(graphStatus) + ', code ' + metaCode + ', subcode ' + metaSubcode + (trace ? ', trace ' + trace : '') + ')' +
          (userMessage && userMessage !== message ? '. ' + userMessage : ''));
        lastError.httpStatus = numeric(graphStatus);
        lastError.metaCode = metaCode;
        lastError.metaSubcode = metaSubcode;
        lastError.retryable = graphStatus === 429 || graphStatus >= 500;
        if (!lastError.retryable) throw lastError;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        lastError.message = safeGraphText(lastError.message, 1000);
        if (lastError.retryable === false || attempt >= maxAttempts) throw lastError;
      }
      await wait(attempt * 3000);
    }
    throw lastError;
  }
  async function waitForContainer(containerId) {
    for (let attempt = 1; attempt <= 18; attempt += 1) {
      const container = await graphRequest(`${containerId}?fields=status_code,status`);
      if (container.status_code === 'FINISHED') return;
      if (container.status_code === 'ERROR' || container.status_code === 'EXPIRED') {
        throw new Error(`Instagram media container ${containerId} ended with ${container.status_code}.`);
      }
      await wait(5000);
    }
    throw new Error(`Instagram media container ${containerId} did not finish within 90 seconds.`);
  }

  const childIds = [];
  const fallbackMentionTags = [];
  for (const slide of payload.slides) {
    const body = { image_url: slide.imageUrl, is_carousel_item: 'true' };
    if (Array.isArray(slide.userTags) && slide.userTags.length) body.user_tags = JSON.stringify(slide.userTags);
    let child;
    try { child = await graphRequest(`${igUserId}/media`, { method: 'POST', body }); }
    catch (error) {
      if (!body.user_tags) throw error;
      delete body.user_tags;
      fallbackMentionTags.push(...slide.userTags.map(tag => tag.username));
      child = await graphRequest(`${igUserId}/media`, { method: 'POST', body });
    }
    if (!child.id) throw new Error('Instagram did not return a media container ID.');
    await waitForContainer(child.id);
    childIds.push(child.id);
  }
  const carousel = await graphRequest(`${igUserId}/media`, { method: 'POST',
    body: { media_type: 'CAROUSEL', children: childIds.join(','), caption: payload.caption, location_id: locationId } });
  if (!carousel.id) throw new Error('Instagram did not return a carousel container ID.');
  await waitForContainer(carousel.id);
  // Recheck before the irreversible publish call; creation failures never mark a post published.
  if (state.pendingSelectionKey || state.lastPublishDate === payload.publishDate) {
    return [{ json: { status: 'blocked_reconciliation_required', ...preview,
      reason: 'Publication state changed while preparing the agenda.' } }];
  }
  state.pendingSelectionKey = payload.selectionKey;
  state.pendingCarouselId = carousel.id;
  state.pendingPublishStartedAt = new Date().toISOString();
  state.pendingPublishError = null;
  let published;
  try {
    published = await graphRequest(`${igUserId}/media_publish`, {
      method: 'POST', body: { creation_id: carousel.id }, maxAttempts: 1,
    });
  } catch (error) {
    state.pendingPublishError = error instanceof Error ? error.message : String(error);
    return [{ json: { status: 'blocked_reconciliation_required', ...preview,
      carouselContainerId: carousel.id, reason: state.pendingPublishError } }];
  }
  if (!published.id) {
    state.pendingPublishError = 'Instagram did not return a published media ID.';
    return [{ json: { status: 'blocked_reconciliation_required', ...preview,
      carouselContainerId: carousel.id, reason: state.pendingPublishError } }];
  }
  state.lastSelectionKey = payload.selectionKey;
  state.lastPublishDate = payload.publishDate;
  state.lastPostId = published.id;
  state.lastLocationId = locationId;
  rememberEventZekaSelection(state, payload);
  state.lastPublishedAt = new Date().toISOString();
  delete state.pendingSelectionKey;
  delete state.pendingCarouselId;
  delete state.pendingPublishStartedAt;
  delete state.pendingPublishError;
  return [{ json: { status: 'published', publishDate: payload.publishDate,
    selectionKey: payload.selectionKey, postId: published.id,
    selectedCount: payload.selectedCount, slideCount: payload.slides.length,
    locationId, locationName: 'Belgrade, Serbia',
    fallbackMentionTags: [...new Set(fallbackMentionTags)] } }];
}
