import assert from 'node:assert/strict';
import { buildDailyCarouselPayload, buildDailyCarouselCaption, getNextIsoDate } from '../lib/social/daily-carousel.ts';
import { buildDailyReelPayload } from '../lib/social/daily-reels.ts';
import { buildDailyStoriesPayload } from '../lib/social/daily-stories.ts';
import { getEventPublicationUsage, readPublicationContext, selectUnpostedFirstEvents } from '../lib/social/publication-history.ts';
import { buildPosterArtwork } from '../lib/social/poster-renderer.ts';
import { POSTER_FAMILIES, POSTER_CYCLE_LENGTH, getPosterDirection, getPosterDesignReceipt } from '../lib/social/poster-directions.ts';
import { buildAgendaPosterSvg, renderAgendaPoster } from '../lib/social/agenda-images.ts';
import { fetchEventZekaPublicationContext, rememberEventZekaSelection } from '../ops/n8n/social-publication-history.mjs';

const publishDate = '2026-10-17', date = '2026-10-18', publicOrigin = 'https://eventzeka.com';
const events = Array.from({ length: 12 }, (_, i) => ({ _id: `varietyevent${String(i).padStart(2, '0')}`,
  title: `Program broj ${i}`, venue: `Prostor ${i}`, date, time: '20:00', timeStatus: 'confirmed', timeSource: 'caption' }));
const ids = payload => payload.eventIds || payload.slides?.flatMap(slide => slide.eventIds || []) || payload.frames.flatMap(frame => frame.eventIds);
const feed = buildDailyCarouselPayload({ events, publishDate, publicOrigin, publishedCaptions: [] });
const reel = buildDailyReelPayload({ events, publishDate, publicOrigin, publishedCaptions: [feed.caption] });
const story = buildDailyStoriesPayload({ events, publishDate: date, publicOrigin, publishedCaptions: [reel.caption, feed.caption] });
assert.equal(reel.selectedCount,4);
assert.equal(new Set([...ids(feed), ...ids(reel), ...ids(story)]).size, 11, 'three feed, four Reel and four Story events are different when enough exist');
assert.deepEqual(story.repeatedEventIds, []);
const prior = buildDailyCarouselPayload({ events, publishDate: '2026-10-16', publicOrigin, publishedCaptions: [] });
const next = buildDailyCarouselPayload({ events, publishDate, publicOrigin, publishedCaptions: [prior.caption] });
assert.ok(ids(next).every(id => !ids(prior).includes(id)), 'overlapping carousel dates rotate away from the actual previous publication');

const unseen = events.slice(0, 2).map(event => ({ ...event, venue: 'Isti prostor', timeStatus: 'unknown' }));
const used = events.slice(2, 5);
const oldCaption = buildDailyCarouselCaption(used);
const choose = (source, context = {}) => selectUnpostedFirstEvents({ events: source, publishDate, eventDates: [date], format: 'feed', ...context });
const sparse = choose([...unseen, ...used], { publishedCaptions: [oldCaption] });
assert.ok(unseen.every(event => sparse.selected.some(item => item._id === event._id)), 'every unseen event outranks repeats, even at the same venue or without a confirmed time');
assert.equal(sparse.selected.length, 3);
assert.equal(sparse.repeatedEventIds.length, 1, 'repeat only the slot that cannot be filled with a new event');
const twice = buildDailyCarouselCaption([used[0]]);
const counts = choose(used, { publishedCaptions: [twice, oldCaption], perDay: 1 });
assert.ok(counts.selected[0]._id !== used[0]._id, 'prefer the least repeated programme');
const recent = buildDailyCarouselCaption([used[1]]), older = buildDailyCarouselCaption([used[2]]);
assert.equal(choose(used.slice(1), { publishedCaptions: [recent, older], perDay: 1 }).selected[0]._id, used[2]._id, 'within equal usage, prefer the older publication');
assert.deepEqual(choose([...unseen, ...used].reverse(), { publishedCaptions: [oldCaption] }), sparse, 'source ordering cannot change the selection');
assert.equal(choose(events, { excludedEventIds: events.map(event => event._id) }).selected.length, 0, 'explicit replacement exclusions remain hard constraints');
const otherDate = buildDailyCarouselCaption([{ ...events[0], date: '2026-10-19' }, events[1]], publicOrigin, [date, '2026-10-19']);
assert.equal(getEventPublicationUsage(events, { publishedCaptions: [otherDate] }).get(events[0]._id).count, 0, 'a recurring title on another date remains eligible');
const edited = { ...used[0], title: 'Novi naziv programa' };
assert.equal(getEventPublicationUsage([edited], { previouslyPublishedEventIds: [edited._id] }).get(edited._id).count, 1, 'saved IDs retain history across later metadata edits');

for (const format of ['feed','story','reel']) {
  const count=format==='feed'?3:4;
  const artwork=buildPosterArtwork({date,position:0,format,events:events.slice(0,count)});
  assert.equal(artwork.rows.length,count);
  assert.equal((artwork.svg.toString().match(/class="time-label"/g)||[]).length,count);
  assert.ok(artwork.rows.every(row=>row.title.lines.length&&row.venue.lines.length));
  assert.ok(!artwork.bounds.some(bound=>bound.role==='intro'));
  assert.doesNotMatch(artwork.svg.toString(),/data-role="intro"/u);
}

assert.equal(POSTER_FAMILIES.length,27);assert.equal(POSTER_CYCLE_LENGTH,81);
let cycleDate='2026-10-19';
const combinations={story:new Set(),feed:new Set(),reel:new Set()};
for(let day=0;day<81;day++,cycleDate=getNextIsoDate(cycleDate)){
 const daily=[];
 for(const format of ['story','feed','reel']){
  const eventDate=format==='story'?cycleDate:getNextIsoDate(cycleDate);
  const theme=getPosterDirection(eventDate,0,format,cycleDate),sequence=day%81;
  assert.equal(theme.id,POSTER_FAMILIES[sequence%27].id,'directions advance in catalogue order, not randomly');
  assert.equal(theme.composition,Math.floor(sequence/27));
  const design=getPosterDesignReceipt(eventDate,0,format,cycleDate);
  assert.equal(design.cycleLength,81);assert.equal(design.publishDate,cycleDate);
  assert.equal(design.key,getPosterDesignReceipt(cycleDate,0,'story',cycleDate).key);
  assert.deepEqual(theme,getPosterDirection(eventDate,0,format,cycleDate),'the same publication date never rerolls its design');
  const key=theme.id+'/'+theme.composition;assert(!combinations[format].has(key));combinations[format].add(key);daily.push(key);
 }
 assert.equal(new Set(daily).size,1,'Story, carousel and Reel share one design on the same publication day');
}
for(const used of Object.values(combinations))assert.equal(used.size,81);

// Sparse and explicitly requested event windows cannot silently choose another
// daily look. The publication date, rather than the first event date, owns it.
const commonPublishDate='2026-10-21',tomorrow='2026-10-22';
const customEvents=events.map((event,index)=>({...event,date:index<6?'2026-10-23':'2026-10-24'}));
const customFeed=buildDailyCarouselPayload({events:customEvents,publishDate:commonPublishDate,publicOrigin,eventDates:['2026-10-23','2026-10-24']});
const sharedStory=buildDailyStoriesPayload({events:events.map(event=>({...event,date:commonPublishDate})),publishDate:commonPublishDate,publicOrigin});
const sharedReel=buildDailyReelPayload({events:events.map(event=>({...event,date:tomorrow})),publishDate:commonPublishDate,publicOrigin});
for(const payload of [customFeed,sharedStory,sharedReel]){
 assert.equal(payload.design.publishDate,commonPublishDate);
 assert.equal(payload.design.key,sharedStory.design.key);
 assert.equal(payload.design.motionVariant,sharedStory.design.motionVariant);
 assert.deepEqual([payload.design.id,payload.design.composition,payload.design.cyclePosition],[sharedStory.design.id,sharedStory.design.composition,sharedStory.design.cyclePosition]);
}
assert.equal(customFeed.selectedCount,6);
assert.equal(customFeed.slides.length,3,'sparse custom window retains its final CTA');
for(const slide of customFeed.slides.filter(slide=>slide.kind==='agenda')){
 const url=new URL(slide.imageUrl);assert.equal(url.searchParams.get('publishDate'),commonPublishDate);
 const theme=getPosterDirection(slide.date,slide.position,'feed',commonPublishDate);
 assert.equal(theme.id,sharedStory.design.id);assert.equal(theme.composition+1,sharedStory.design.composition);
}
assert.notEqual(getPosterDesignReceipt(commonPublishDate,0,'story',commonPublishDate).key,getPosterDesignReceipt('2026-10-22',0,'story','2026-10-22').key);

const requests = [];
const httpRequest = async request => {
  requests.push(request);
  return { statusCode: 200, body: requests.length === 1 ? { data: [{ caption: feed.caption, timestamp: '2026-10-17T14:30:00Z' }],
    paging: { next: 'https://untrusted.invalid/?access_token=never-follow', cursors: { after: 'encoded+cursor' } } }
    : { data: [{ caption: 'Old programme', timestamp: '2026-09-01T12:00:00Z' }] } };
};
const receipt = { lastPostId: 'preserved', lastSelectionKey: `${publishDate}:${date}:${events[0]._id}@old`, publicationSelections: [] };
const snapshot = structuredClone(receipt);
const context = await fetchEventZekaPublicationContext({ httpRequest, graphBase: 'https://graph.instagram.com', graphVersion: 'v25.0', accessToken: 'private', userId: '111', today: publishDate, state: receipt });
assert.deepEqual(context.publishedCaptions, [feed.caption]);
assert.ok(context.previouslyPublishedEventIds.includes(events[0]._id));
assert.ok(requests[1].url.startsWith('https://graph.instagram.com/v25.0/111/media?'));
assert.ok(requests[1].url.endsWith('&after=encoded%2Bcursor'));
assert.deepEqual(receipt, snapshot, 'history reads cannot change any publication receipt');
for (const body of [{ data: [{}] }, { data: [{ timestamp: '2026-10-17', caption: 'x'.repeat(2201) }] },
  { data: [], paging: { next: 'exists' } }]) {
  await assert.rejects(fetchEventZekaPublicationContext({ httpRequest: async () => ({ statusCode: 200, body }), graphBase: 'x', graphVersion: 'v', accessToken: 'private', userId: '1', today: publishDate }), /history|caption/);
}
await assert.rejects(fetchEventZekaPublicationContext({ httpRequest: async () => ({ statusCode: 500, body: { error: { message: 'private' } } }), graphBase: 'x', graphVersion: 'v', accessToken: 'private', userId: '1', today: publishDate }), /^Error: Could not verify recent publication history\.$/);
rememberEventZekaSelection(receipt, feed);
assert.equal(receipt.lastPostId, 'preserved'); assert.deepEqual(receipt.lastEventIds, ids(feed));
for (let n = 0; n < 40; n++) rememberEventZekaSelection(receipt, { ...feed, selectionKey: `receipt-${n}` });
assert.equal(receipt.publicationSelections.length, 31);
const parsed = await readPublicationContext(new Request(publicOrigin, { method: 'POST', body: JSON.stringify(context) }));
assert.deepEqual(parsed, context);
for (const body of ['{}', 'null', JSON.stringify({ publishedCaptions: ['x'.repeat(2201)] }), JSON.stringify({ publishedCaptions: [], previouslyPublishedEventIds: ['invalid!'] })]) {
  await assert.rejects(readPublicationContext(new Request(publicOrigin, { method: 'POST', body })));
}
console.log('Social variety QA passed: cross-format history, unseen-first sparse fallback, date isolation, four-event Stories, illustrated posters, fixed time frames, bounded history and receipts.');
