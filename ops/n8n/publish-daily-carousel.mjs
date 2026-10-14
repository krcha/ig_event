// Self-contained: the workflow generator embeds this function in the n8n Code node.
export async function publishEventZekaCarousel({ env, httpRequest, getStaticData }) {
  const origin = String(env.EVENTZEKA_API_ORIGIN || '').replace(/\/+$/, '');
  const cronSecret = String(env.EVENTZEKA_CRON_SECRET || '');
  const graphBase = String(env.EVENTZEKA_IG_GRAPH_BASE_URL || 'https://graph.instagram.com').replace(/\/+$/, '');
  const graphVersion = String(env.EVENTZEKA_IG_GRAPH_VERSION || 'v25.0').replace(/^\/+|\/+$/g, '');
  const igUserId = String(env.EVENTZEKA_IG_USER_ID || '');
  const accessToken = String(env.EVENTZEKA_IG_ACCESS_TOKEN || '');
  if (!origin || !cronSecret) throw new Error('Event Zeka API origin or cron secret is not configured.');

  function parseJsonBody(body) {
    if (body && typeof body === 'object') return body;
    try { return body ? JSON.parse(String(body)) : {}; } catch { return {}; }
  }
  const response = await httpRequest({
    method: 'GET', url: `${origin}/api/social/daily-carousel`,
    headers: { Authorization: `Bearer ${cronSecret}`, Accept: 'application/json' },
    returnFullResponse: true, ignoreHttpStatusErrors: true,
  });
  const status = Number(response.statusCode || 0);
  const payload = parseJsonBody(response.body);
  if (status < 200 || status >= 300) throw new Error(`Carousel generator failed: ${payload.error || `HTTP ${status || 'unknown'}`}`);
  if (!payload.selectedCount || !Array.isArray(payload.slides) || !payload.slides.length) {
    return [{ json: { status: 'skipped_no_events', publishDate: payload.publishDate, selectedCount: 0 } }];
  }
  if (!payload.selectionKey || !payload.publishDate || payload.slides.length > 3 ||
      payload.slides.some(slide => slide.kind !== 'agenda' || !slide.imageUrl || !Array.isArray(slide.eventIds))) {
    throw new Error('Invalid three-day agenda payload.');
  }
  const preview = {
    publishDate: payload.publishDate, selectionKey: payload.selectionKey,
    selectedCount: payload.selectedCount, slideCount: payload.slides.length,
    eventDates: payload.eventDates,
    previewUrls: payload.slides.map(slide => slide.imageUrl),
    venues: [...new Set(payload.slides.flatMap(slide => (slide.userTags || []).map(tag => `@${tag.username}`)))],
  };
  const dryRun = String(env.EVENTZEKA_SOCIAL_DRY_RUN || '').toLowerCase() === 'true';
  const state = dryRun ? null : getStaticData();
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
  async function graphRequest(path, options = {}) {
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
        const message = data?.error?.message || data?.error?.error_user_msg || `HTTP ${graphStatus || 'unknown'}`;
        lastError = new Error(`Instagram Graph request failed for ${path}: ${message}`);
        lastError.retryable = graphStatus === 429 || graphStatus >= 500;
        if (!lastError.retryable) throw lastError;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
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

  const isCarousel = payload.slides.length > 1;
  const childIds = [];
  const fallbackMentionTags = [];
  for (const slide of payload.slides) {
    const body = { image_url: slide.imageUrl,
      ...(isCarousel ? { is_carousel_item: 'true' } : { caption: payload.caption }) };
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
  const carousel = isCarousel ? await graphRequest(`${igUserId}/media`, { method: 'POST',
    body: { media_type: 'CAROUSEL', children: childIds.join(','), caption: payload.caption } }) : { id: childIds[0] };
  if (!carousel.id) throw new Error('Instagram did not return a carousel container ID.');
  if (isCarousel) await waitForContainer(carousel.id);
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
  state.lastPublishedAt = new Date().toISOString();
  delete state.pendingSelectionKey;
  delete state.pendingCarouselId;
  delete state.pendingPublishStartedAt;
  delete state.pendingPublishError;
  return [{ json: { status: 'published', publishDate: payload.publishDate,
    selectionKey: payload.selectionKey, postId: published.id,
    selectedCount: payload.selectedCount, slideCount: payload.slides.length,
    fallbackMentionTags: [...new Set(fallbackMentionTags)] } }];
}
