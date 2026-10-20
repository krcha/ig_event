import { fetchEventZekaPublicationContext, rememberEventZekaSelection } from './social-publication-history.mjs';
// Facebook Login remains required for Instagram catalog music.
export async function publishEventZekaReel({ env, httpRequest, getStaticData, now = () => new Date(), random = Math.random, forceDryRun = false }) {

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
    format: 'reel', resumeDate: '2026-10-26', specialWorkflowId: 'EzekaSpecial20261025' } }];
  const origin = String(env.EVENTZEKA_API_ORIGIN || '').replace(/\/+$/, '');
  const mediaOrigin = String(env.EVENTZEKA_REELS_PUBLIC_ORIGIN || 'https://eventzeka.com').replace(/\/+$/, '');
  const secret = String(env.EVENTZEKA_CRON_SECRET || '');
  const token = String(env.EVENTZEKA_REELS_FB_ACCESS_TOKEN || '');
  const userId = String(env.EVENTZEKA_REELS_IG_USER_ID || '');
  const locationId = String(env.EVENTZEKA_REELS_LOCATION_ID || '');
  const version = String(env.EVENTZEKA_REELS_GRAPH_VERSION || 'v25.0');
  const replacementId = String(env.EVENTZEKA_REEL_REPLACE_ID || '');
  const dry = forceDryRun || String(env.EVENTZEKA_SOCIAL_DRY_RUN || '').toLowerCase() === 'true';
  if (!origin || !secret || !/^v\d+\.\d+$/.test(version)) throw new Error('Invalid Reel runtime configuration.');
  const dateInBelgrade = () => {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Belgrade', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now());
    return ['year','month','day'].map(key => parts.find(part => part.type === key).value).join('-');
  };
  const today = dateInBelgrade();
  const tomorrow = day => { const value = new Date(`${day}T12:00:00Z`); value.setUTCDate(value.getUTCDate() + 1); return value.toISOString().slice(0, 10); };
  const state = dry ? null : getStaticData();
  const redact = error => {
    let message = error instanceof Error ? error.message : String(error);
    for (const value of [token, secret]) if (value) message = message.replaceAll(value, '[redacted]');
    return message;
  };
  if (state?.pending) return [{ json: { status: 'blocked_reconciliation_required', publishDate: today, pendingDate: state.pending.publishDate,
    containerId: state.pending.containerId, reason: state.pending.error || 'A Reel publication has an unknown outcome.' } }];
  const replacing = !dry && replacementId && state.lastPublishDate === today && state.lastReelId === replacementId;
  if (!dry && replacementId && !replacing) throw new Error('Replacement does not match today\'s published Reel.');
  if (state?.lastPublishDate === today && !replacing) return [{ json: { status: 'skipped_already_published', publishDate: today, reelId: state.lastReelId } }];
  const parse = body => { if (body && typeof body === 'object') return body; try { return JSON.parse(body || '{}'); } catch { return {}; } };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function graph(path, body) {
    const response = await httpRequest({ method: body ? 'POST' : 'GET', url: `https://graph.facebook.com/${version}/${path}`,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      body: body ? Object.entries(body).map(([key,value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`).join('&') : undefined,
      returnFullResponse: true, ignoreHttpStatusErrors: true, timeout: 120000 });
    const data = parse(response.body);
    if (Number(response.statusCode) < 200 || Number(response.statusCode) >= 300) throw new Error(redact(data.error?.message || `Instagram Reel request returned HTTP ${response.statusCode}.`));
    return data;
  }
  let payload = !dry && state.prepared?.publishDate === today ? state.prepared : null;
  if (!payload) {
    const previewDate = dry ? String(env.EVENTZEKA_REEL_PREVIEW_DATE || '') : '';
    if (previewDate && !/^\d{4}-\d{2}-\d{2}$/.test(previewDate)) throw new Error('Invalid Reel preview date.');
    let context;
    if ((!dry || String(env.EVENTZEKA_SOCIAL_PREVIEW_HISTORY || '').toLowerCase() === 'true') && token && /^\d+$/.test(userId)) {
      context = await fetchEventZekaPublicationContext({ httpRequest, graphBase: 'https://graph.facebook.com', graphVersion: version,
        accessToken: token, userId, today, state: state || {} });
      const excludedEventIds = replacing ? String(state.lastSelectionKey || '').split(':').at(-1).split('@')[0].split(',') : [];
      if (excludedEventIds.some(id => !/^[a-z0-9]{10,64}$/.test(id))) throw new Error('Could not verify the previous Reel events.');
      context.excludedEventIds = excludedEventIds;
    }
    const response = await requestGenerator({ method: context ? 'POST' : 'GET', url: `${origin}/api/social/daily-reels${previewDate ? `?date=${previewDate}` : ''}`,
      headers: { Authorization: `Bearer ${secret}`, Accept: 'application/json', ...(context ? { 'Content-Type': 'application/json' } : {}) },
      body: context ? JSON.stringify(context) : undefined, returnFullResponse: true, ignoreHttpStatusErrors: true }, 'Reel generator');
    if (Number(response.statusCode) !== 200) throw new Error('Reel generator request failed.');
    payload = parse(response.body);
  }
  if (!dry && payload.publishDate !== today) throw new Error('Reel payload is not for the current Belgrade date.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(payload.publishDate || '') || payload.eventDate !== tomorrow(payload.publishDate) ||
    !Number.isInteger(payload.selectedCount) || !Array.isArray(payload.eventIds)) throw new Error('Reels must preview tomorrow\'s events.');
  if (payload.selectedCount === 0 && payload.eventIds.length === 0 && !payload.videoUrl && !payload.coverUrl) return [{ json: { status: payload.sourceEventCount > 0 ? 'skipped_no_new_events' : 'skipped_no_events', publishDate: payload.publishDate, eventDate: payload.eventDate } }];
  const expected = `${mediaOrigin}/api/social/reels/days/${payload.eventDate}?`;
  const videoQuery = typeof payload.videoUrl === 'string' ? payload.videoUrl.split('?')[1]?.split('&') || [] : [];
  if (payload.selectedCount < 1 || payload.selectedCount > 4 || payload.eventIds.length !== payload.selectedCount ||
    new Set(payload.eventIds).size !== payload.eventIds.length || !payload.selectionKey || payload.durationSeconds !== 18 || payload.hasClosingCta !== true ||
    payload.selectionPolicy !== 'prefer_unposted' || !Array.isArray(payload.repeatedEventIds) || !Array.isArray(payload.excludedEventIds) || payload.eventIds.some(id => payload.excludedEventIds.includes(id)) ||
    payload.locationName !== 'Belgrade, Serbia' || payload.musicMode !== 'instagram_catalog' || typeof payload.caption !== 'string' || !payload.caption || payload.caption.length > 2200 ||
    ![payload.videoUrl,payload.coverUrl].every(url => typeof url === 'string' && url.startsWith(expected) && /[?&]v=r5-[a-z0-9]+(?:&|$)/.test(url)) ||
    videoQuery.filter(value => value.startsWith('publishDate=')).length !== 1 || !videoQuery.includes(`publishDate=${payload.publishDate}`) ||
    /[?&]cover=/.test(payload.videoUrl) || payload.coverUrl !== `${payload.videoUrl}&cover=1`) throw new Error('Invalid exact-image Reel payload: an 18-second closing CTA is required.');
  const preview = { design: payload.design || null, publishDate: payload.publishDate, eventDate: payload.eventDate, selectedCount: payload.selectedCount,
    repeatedEventIds: payload.repeatedEventIds, videoUrl: payload.videoUrl, coverUrl: payload.coverUrl, durationSeconds: 18, hasClosingCta: true, locationName: payload.locationName, musicMode: payload.musicMode };
  for (const [url, type] of [[payload.videoUrl,'video/mp4'],[payload.coverUrl,'image/jpeg']]) {
    const response = await httpRequest({ method: 'HEAD', url, returnFullResponse: true, ignoreHttpStatusErrors: true, timeout: 420000 });
    if (Number(response.statusCode) !== 200 || !String(response.headers?.['content-type'] || response.headers?.['Content-Type'] || '').startsWith(type) ||
      (type === 'video/mp4' && !/^bytes$/i.test(String(response.headers?.['accept-ranges'] || response.headers?.['Accept-Ranges'] || '')))) throw new Error('Exact Reel media preflight failed.');
  }
  const range = await httpRequest({ method: 'GET', url: payload.videoUrl, headers: { Range: 'bytes=0-31' },
    encoding: 'arraybuffer', returnFullResponse: true, ignoreHttpStatusErrors: true, timeout: 420000 });
  if (Number(range.statusCode) !== 206 || !/^bytes 0-31\/[1-9]\d*$/i.test(String(range.headers?.['content-range'] || range.headers?.['Content-Range'] || '')) ||
    !/^video\/mp4(?:;|$)/i.test(String(range.headers?.['content-type'] || range.headers?.['Content-Type'] || ''))) throw new Error('Exact Reel video byte-range preflight failed.');
  if (dry) return [{ json: { status: 'dry_run', ...preview, caption: payload.caption } }];
  if (!token || !/^\d+$/.test(userId)) return [{ json: { status: 'blocked_facebook_login_required', ...preview } }];
  if (!/^\d+$/.test(locationId)) return [{ json: { status: 'blocked_belgrade_location_required', ...preview } }];
  let prepared = payload;
  if (!prepared.audioId) {
    const catalog = await graph(`ig_audio?audio_type=music&user_id=${encodeURIComponent(userId)}`);
    const seenSongs = new Set();
    const tracks = (Array.isArray(catalog.audio) ? catalog.audio : []).map((track,index) => ({ ...track, catalogRank: index + 1 })).filter(track => /^\d+$/.test(String(track.audio_id || '')) &&
      Number(track.duration_in_ms) >= payload.durationSeconds * 1000 && typeof track.title === 'string' && track.title.trim() &&
      (typeof track.audio_type !== 'string' || track.audio_type === 'music')).filter(track => {
        const song = `${track.title}:${track.display_artist || ''}`.toLocaleLowerCase();
        if (seenSongs.has(song)) return false;
        seenSongs.add(song); return true;
      }).slice(0,3);
    if (!tracks.length) return [{ json: { status: 'blocked_no_catalog_music', ...preview } }];
    const different = tracks.filter(track => String(track.audio_id) !== state.lastAudioId &&
      !(track.title === state.lastAudioTitle && (track.display_artist || '') === (state.lastAudioArtist || '')));
    const choices = different.length ? different : tracks;
    const choice = choices[Math.min(choices.length - 1, Math.max(0, Math.floor(random() * choices.length)))];
    prepared = { ...payload, audioId: String(choice.audio_id), audioTitle: choice.title, audioArtist: choice.display_artist || '', audioCatalogRank: choice.catalogRank, locationId };
  }
  if (prepared.locationId !== locationId) return [{ json: { status: 'blocked_location_changed', ...preview } }];
  if (!prepared.containerId) {
    const result = await graph(`${userId}/media`, { media_type: 'REELS', video_url: prepared.videoUrl, cover_url: prepared.coverUrl,
      caption: prepared.caption, share_to_feed: 'false', location_id: prepared.locationId,
      audio_configuration: JSON.stringify({ audio_id: prepared.audioId, audio_volume: 80, video_volume: 1 }) });
    if (!result.id) throw new Error('Instagram did not return a Reel container ID.');
    prepared = { ...prepared, containerId: result.id };
  }
  state.prepared = prepared;
  let finished = false;
  for (let attempt = 0; attempt < 36; attempt++) {
    const status = await graph(`${prepared.containerId}?fields=status_code,status`);
    if (status.status_code === 'FINISHED') { finished = true; break; }
    if (status.status_code === 'ERROR' || status.status_code === 'EXPIRED') return [{ json: { status: 'blocked_container_failed', ...preview, containerId: prepared.containerId } }];
    await wait(5000);
  }
  if (!finished) return [{ json: { status: 'blocked_container_processing', ...preview, containerId: prepared.containerId } }];
  if (dateInBelgrade() !== prepared.publishDate) return [{ json: { status: 'blocked_stale_date', ...preview } }];
  if (state.pending || (state.lastPublishDate === today && !(replacing && state.lastReelId === replacementId))) return [{ json: { status: 'blocked_reconciliation_required', ...preview } }];
  state.pending = { publishDate: today, selectionKey: prepared.selectionKey, containerId: prepared.containerId,
    audioId: prepared.audioId, locationId: prepared.locationId, startedAt: now().toISOString() };
  let published;
  try {
    // An ambiguous publish is never retried automatically.
    published = await graph(`${userId}/media_publish`, { creation_id: prepared.containerId });
    if (!published.id) throw new Error('Instagram did not return a published Reel ID.');
  } catch (error) {
    state.pending.error = redact(error);
    return [{ json: { status: 'blocked_reconciliation_required', ...preview, containerId: prepared.containerId, reason: state.pending.error } }];
  }
  if (replacing) state.previousPublications = [...(state.previousPublications || []), Object.fromEntries(Object.entries(state).filter(([key]) => key.startsWith('last')))].slice(-30);
  state.lastPublishDate = today; state.lastEventDate = prepared.eventDate; state.lastReelId = published.id;
  state.lastSelectionKey = prepared.selectionKey; state.lastAudioId = prepared.audioId; state.lastAudioTitle = prepared.audioTitle;
  state.lastAudioArtist = prepared.audioArtist; state.lastLocationId = prepared.locationId; state.lastPublishedAt = now().toISOString();
  state.lastAudioCatalogRank = prepared.audioCatalogRank;
  rememberEventZekaSelection(state, prepared);
  delete state.pending; delete state.prepared;
  return [{ json: { status: 'published', ...preview, reelId: published.id, replacesReelId: replacing ? replacementId : null, audioId: state.lastAudioId, audioTitle: state.lastAudioTitle, audioArtist: state.lastAudioArtist, audioCatalogRank: state.lastAudioCatalogRank, locationId } }];
}
