import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { ConvexHttpClient } from 'convex/browser';
import { buildDailyStoriesPayload, buildStoryAgendaRenderVersion, isEventAvailableForMorningStory } from '../lib/social/daily-stories.ts';
import { buildAgendaPosterSvg, renderAgendaPoster } from '../lib/social/agenda-images.ts';
import { buildPosterArtwork } from '../lib/social/poster-renderer.ts';
import { buildPosterLayout } from '../lib/social/poster-layout.ts';
import { getAgendaEventDetail, getAgendaEventTime } from '../lib/social/daily-carousel.ts';
import { GET as getPayload } from '../app/api/social/daily-stories/route.ts';
import { GET as getAgenda } from '../app/api/social/stories/days/[date]/route.ts';

const date = '2026-10-15';
const events = Array.from({ length: 5 }, (_, index) => ({ _id: `abcdefghijk${index}`, title: `Program ${index}`, venue: `Prostor ${index}`,
  date, time: `${18 + index}:00`, timeStatus: 'confirmed', timeSource: 'caption', venueInstagramHandle: undefined }));
const source = [...events, { ...events[0], _id: 'earlyabcdefgh', time: '09:59' }, { ...events[0], _id: 'futureabcdefgh', date: '2026-10-16' }];
const payload = buildDailyStoriesPayload({ events: source, publishDate: date, publicOrigin: 'https://eventzeka.com/' });
assert.equal(payload.selectedCount, 4);
assert.equal(payload.sourceEventCount, 6);
assert.equal(payload.frames.length, 1);
assert.equal(payload.frames[0].date, date);
assert.equal(payload.frames[0].kind, 'agenda');
assert.equal(payload.durationSeconds,18);assert.equal(payload.hasClosingCta,true);
assert.equal(payload.frames[0].mediaType,'VIDEO');assert.equal(payload.frames[0].durationSeconds,18);assert.equal(payload.frames[0].hasClosingCta,true);
assert.equal(new URL(payload.frames[0].imageUrl).searchParams.get('cover'),'1');
assert.equal(new URL(payload.frames[0].videoUrl).searchParams.has('cover'),false);
assert.equal(new URL(payload.frames[0].videoUrl).searchParams.get('publishDate'),date);
assert.match(new URL(payload.frames[0].videoUrl).searchParams.get('v'),/^s5-/);
assert.equal(new URL(payload.frames[0].videoUrl).searchParams.get('v'),new URL(payload.frames[0].imageUrl).searchParams.get('v'));
assert.deepEqual(payload.frames[0].userTags, [], 'missing profiles are not invented');
assert.ok(!payload.selectionKey.includes('cta'));
assert.deepEqual(payload, buildDailyStoriesPayload({ events: [...source].reverse(), publishDate: date, publicOrigin: 'https://eventzeka.com/' }));
assert.ok(!payload.frames[0].eventIds.includes('earlyabcdefgh') && !payload.frames[0].eventIds.includes('futureabcdefgh'));
assert.equal(isEventAvailableForMorningStory({ ...events[0], time: '10:00' }, date), true);
assert.equal(isEventAvailableForMorningStory({ ...events[0], time: '09:00', timeStatus: 'inferred' }, date), true);
assert.equal(isEventAvailableForMorningStory({ ...events[0], time: '01:00 - 05:00' }, date), false);
assert.equal(buildDailyStoriesPayload({ events: [events[0]], publishDate: date, publicOrigin: 'https://eventzeka.com' }).selectedCount, 1);
assert.deepEqual(buildDailyStoriesPayload({ events: [source.at(-1)], publishDate: date, publicOrigin: 'https://eventzeka.com' }).frames, []);
const taggedEvents=events.slice(0,4).map((event,i)=>({...event,venueInstagramHandle:[' @space.one ','space.two','space.one','not a handle'][i]}));
const tagged=buildDailyStoriesPayload({events:taggedEvents,publishDate:date,publicOrigin:'https://eventzeka.com'});
assert.equal(tagged.frames[0].userTags.length,2,'duplicate and invalid handles are omitted');
assert.deepEqual(new Set(tagged.frames[0].userTags.map(tag=>tag.username)),new Set(['space.one','space.two']));
const ordered=tagged.frames[0].eventIds.map(id=>taggedEvents.find(event=>event._id===id));
const layout=buildPosterLayout(ordered.map(event=>({title:event.title,venue:event.venue,time:getAgendaEventTime(event),detail:getAgendaEventDetail(event)})),{date,position:0,format:'story'});
for(const tag of tagged.frames[0].userTags){
 const index=ordered.findIndex(event=>event.venueInstagramHandle.trim().replace(/^@+/,'')===tag.username),row=layout.rows[index];
 assert(tag.x>0&&tag.x<1&&tag.y>0&&tag.y<1);
 assert(Math.abs(tag.y*1920-(row.venueTop+row.venue.height/2))<.1,'Story tags use its actual 1920px layout, not feed coordinates');
}
const chosen = payload.frames[0].eventIds.map(id => events.find(event => event._id === id));
const image = await renderAgendaPoster({ date, events: chosen, position: 0, format: 'story' });
for (const bytes of [image]) {
  const info = await sharp(bytes).metadata();
  assert.deepEqual([info.width, info.height, info.format], [1080, 1920, 'jpeg']);
  assert.ok(bytes.length < 8_000_000);
  const artwork=buildPosterArtwork({date,events:chosen,position:0,format:'story'});
  assert.ok(artwork.bounds.every(b=>b.x>=48&&b.x+b.width<=938&&b.y>=226&&b.y+b.height<=1560),'Story text avoids Instagram UI; background artwork can bleed');
  assert.ok(!artwork.bounds.some(bound=>bound.role==='intro'),'Story runs straight from the date into events');
}
const svg = buildAgendaPosterSvg({ date, events: chosen, position: 0, format: 'story' }).toString();
assert.match(svg, /aria-label="DANAS"/);
assert.ok(svg.includes('<image') && !svg.includes('<text'));
assert.equal((svg.match(/class="time-label"/g)||[]).length,4);
assert.doesNotMatch(svg,/data-role="intro"/u);
const feedSvg = buildAgendaPosterSvg({ date, events: chosen.slice(0,3), position: 0 }).toString();
assert.ok(!svg.includes('aria-label="BEOGRAD / 01/04"'), "a single Story has no carousel page counter");
assert.ok(feedSvg.includes('aria-label="BEOGRAD / 01/04"'), "the feed keeps its page counter");

// Exercise an appended family through the actual Story payload and tag layout,
// while retaining the older-date fixtures below as historical regressions.
const appendedDate='2026-11-14',appendedEvents=events.slice(0,4).map((event,index)=>({...event,date:appendedDate,venueInstagramHandle:`space.${index}`}));
const appended=buildDailyStoriesPayload({events:appendedEvents,publishDate:appendedDate,publicOrigin:'https://eventzeka.com'});
assert.deepEqual([appended.design.id,appended.design.cycleLength,appended.selectedCount,appended.frames.length],['27',81,4,1]);
assert.equal(appended.frames[0].userTags.length,4);
const appendedOrdered=appended.frames[0].eventIds.map(id=>appendedEvents.find(event=>event._id===id));
const appendedArt=buildPosterArtwork({date:appendedDate,events:appendedOrdered,position:0,format:'story'});
assert.equal(appendedArt.theme.id,'27');assert.equal(appendedArt.rows.length,4);
assert.equal((appendedArt.svg.toString().match(/width="168" height="108"/g)||[]).length,4);
assert.doesNotMatch(appendedArt.svg.toString(),/data-role="intro"/u);
for(const tag of appended.frames[0].userTags){
 const index=appendedOrdered.findIndex(event=>event.venueInstagramHandle===tag.username),row=appendedArt.rows[index];
 assert(Math.abs(tag.y*1920-(row.venueTop+row.venue.height/2))<.1,'new-family Story tags follow its measured venue text');
}
assert.equal(new URL(appended.frames[0].imageUrl).searchParams.get('v'),buildStoryAgendaRenderVersion(appendedDate,appendedOrdered));

const temporary=await mkdtemp(path.join(os.tmpdir(),'qa-eventzeka-story-')),exec=promisify(execFile);
const originals = { secret: process.env.CRON_SECRET, convex: process.env.NEXT_PUBLIC_CONVEX_URL, origin: process.env.EVENT_ZEKA_PUBLIC_ORIGIN, cache:process.env.EVENTZEKA_REEL_CACHE_DIR, query: ConvexHttpClient.prototype.query };
process.env.EVENTZEKA_REEL_CACHE_DIR=temporary;
process.env.CRON_SECRET = 'qa-stories-secret';
process.env.NEXT_PUBLIC_CONVEX_URL = 'https://qa-stories.convex.cloud';
process.env.EVENT_ZEKA_PUBLIC_ORIGIN = 'https://eventzeka.com';
const request = suffix => new Request(`https://eventzeka.com/api/social/daily-stories${suffix}`, { headers: { authorization: 'Bearer qa-stories-secret' } });
try {
  assert.equal((await getPayload(new Request('https://eventzeka.com/api/social/daily-stories'))).status, 401);
  assert.equal((await getPayload(request('?date=2026-02-29'))).status, 400);
  assert.equal((await getPayload(request(`?date=${date}&date=${date}`))).status, 400);
  const calls = [];
  ConvexHttpClient.prototype.query = async (_, args) => {
    calls.push(args);
    return args.cursor === null ? { page: source.slice(0, 2), isDone: false, continueCursor: 'next' } : { page: source.slice(2), isDone: true, continueCursor: '' };
  };
  const generated = await getPayload(request(`?date=${date}`));
  assert.equal(generated.status, 200);
  assert.deepEqual(await generated.json(), payload);
  assert.ok(calls.every(call => call.fromDate === date && call.beforeDate === '2026-10-16'));
  ConvexHttpClient.prototype.query = async () => ({ page: [events[0]], isDone: false, continueCursor: 'repeated' });
  assert.equal((await getPayload(request(`?date=${date}`))).status, 503, 'an incomplete window is never published as a partial result');
  ConvexHttpClient.prototype.query = async (_, args) => ({ ...events.find(event => event._id === args.id), status: 'approved' });
  const routeRequest = new Request(payload.frames[0].imageUrl);
  const context = { params: Promise.resolve({ date }) };
  const oversized=new URL(payload.frames[0].imageUrl);oversized.searchParams.set('events',events.map(e=>e._id).join(','));
  assert.equal((await getAgenda(new Request(oversized),context)).status,400,'five-event Stories are rejected');
  const coverResponse=await getAgenda(routeRequest, context);
  assert.equal(coverResponse.status,200);assert.equal(coverResponse.headers.get('content-type'),'image/jpeg');
  for(const change of [{publishDate:'2026-02-29'},{publishDate:''},{cover:'2'}]){
    const invalid=new URL(payload.frames[0].imageUrl);for(const [key,value]of Object.entries(change))invalid.searchParams.set(key,value);
    assert.equal((await getAgenda(new Request(invalid),context)).status,400);
  }
  for(const parameter of ['publishDate','cover']){
    const duplicate=new URL(payload.frames[0].imageUrl);duplicate.searchParams.append(parameter,duplicate.searchParams.get(parameter));
    assert.equal((await getAgenda(new Request(duplicate),context)).status,400);
  }
  const wrongPublication=new URL(payload.frames[0].imageUrl);wrongPublication.searchParams.set('publishDate','2026-10-14');
  assert.equal((await getAgenda(new Request(wrongPublication),context)).status,400,'a Story event date must equal its publication date');
  const storyVideo=await getAgenda(new Request(payload.frames[0].videoUrl),context);
  assert.equal(storyVideo.status,200);assert.equal(storyVideo.headers.get('content-type'),'video/mp4');
  assert.equal(storyVideo.headers.get('cache-control'),'public, max-age=60, must-revalidate');
  const videoBytes=Buffer.from(await storyVideo.arrayBuffer()),file=path.join(temporary,'story-proof.mp4');await writeFile(file,videoBytes);
  const probe=JSON.parse((await exec('ffprobe',['-v','error','-show_format','-show_streams','-of','json',file])).stdout),video=probe.streams.find(stream=>stream.codec_type==='video'),audio=probe.streams.find(stream=>stream.codec_type==='audio');
  assert.deepEqual([video.codec_name,video.width,video.height,video.pix_fmt,video.avg_frame_rate],['h264',1080,1920,'yuv420p','30/1']);
  assert.equal(Number(video.nb_frames),540);assert.equal(audio.codec_name,'aac');assert.ok(Math.abs(Number(probe.format.duration)-18)<.1);
  await exec('ffmpeg',['-v','error','-xerror','-i',file,'-f','null','-'],{timeout:60000,maxBuffer:100000});
  const ending=[];
  for(const t of [15,17]){const{stdout:png}=await exec('ffmpeg',['-v','error','-ss',String(t),'-i',file,'-frames:v','1','-f','image2pipe','-vcodec','png','-'],{encoding:'buffer',maxBuffer:12000000});ending.push(await sharp(png).extract({left:0,top:1740,width:1080,height:180}).resize(360,60).removeAlpha().raw().toBuffer());}
  let changed=0;for(let i=0;i<ending[0].length;i+=3)if(Math.max(...[0,1,2].map(channel=>Math.abs(ending[0][i+channel]-ending[1][i+channel])))>12)changed++;
  assert.ok(changed/(360*60)>.01,'Story CTA retains the living background during its final hold');
  assert.deepEqual(Buffer.from(await (await getAgenda(new Request(payload.frames[0].videoUrl),context)).arrayBuffer()),videoBytes,'the exact Story video is safely reused from cache');
  const ranged=await getAgenda(new Request(payload.frames[0].videoUrl,{headers:{range:'bytes=0-99'}}),context);
  assert.equal(ranged.status,206);assert.deepEqual(Buffer.from(await ranged.arrayBuffer()),videoBytes.subarray(0,100));
  assert.equal((await (await getAgenda(new Request(payload.frames[0].videoUrl,{method:'HEAD'}),context)).arrayBuffer()).byteLength,0);
  assert.equal((await getAgenda(new Request(payload.frames[0].imageUrl + '&v=s1-stale'), context)).status, 400);
  const stale = new URL(payload.frames[0].imageUrl); stale.searchParams.set('v', 's1-stale');
  assert.equal((await getAgenda(new Request(stale), context)).status, 409);
  ConvexHttpClient.prototype.query = async (_, args) => ({ ...events.find(event => event._id === args.id), status: 'approved', ticketPrice: '1000 RSD' });
  assert.equal((await getAgenda(routeRequest, context)).status, 409);
  ConvexHttpClient.prototype.query = async () => null;
  assert.equal((await getAgenda(routeRequest, context)).status, 404);
  ConvexHttpClient.prototype.query = async (_, args) => ({ ...events.find(event => event._id === args.id), status: 'pending' });
  assert.equal((await getAgenda(routeRequest, context)).status, 404);
  assert.equal((await getAgenda(new Request(payload.frames[0].videoUrl),context)).status,404,'cached Story video still rechecks moderation');
  assert.equal(new URL(payload.frames[0].imageUrl).searchParams.get('v'), buildStoryAgendaRenderVersion(date, chosen));
} finally {
  ConvexHttpClient.prototype.query = originals.query;
  for (const [key, value] of [['CRON_SECRET', originals.secret], ['NEXT_PUBLIC_CONVEX_URL', originals.convex], ['EVENT_ZEKA_PUBLIC_ORIGIN', originals.origin],['EVENTZEKA_REEL_CACHE_DIR',originals.cache]]) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await rm(temporary,{recursive:true,force:true});
}
console.log('Daily Story QA passed: today-only selection, animated 18-second VIDEO with living CTA, safe native text, publication-bound versions/cache and moderation checks.');
