import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { ConvexHttpClient } from 'convex/browser';
import { buildDailyReelPayload, buildReelRenderVersion } from '../lib/social/daily-reels.ts';
import { buildDailyCarouselCaption, selectDailyCarouselEvents } from '../lib/social/daily-carousel.ts';
import { buildPosterArtwork } from '../lib/social/poster-renderer.ts';
import { buildAgendaPosterSvg } from '../lib/social/agenda-images.ts';
import { renderDailyReel, renderReelCover, reelVideoResponse } from '../lib/social/reel-video.ts';
import { GET as getPayload, POST as postPayload } from '../app/api/social/daily-reels/route.ts';
import { GET as getVideo } from '../app/api/social/reels/days/[date]/route.ts';

const exec = promisify(execFile);
const date = '2026-10-15';
const events = Array.from({length:7}, (_,index) => ({ _id: `abcdefghijk${index}`, title: `Program ${index}`, venue: `Prostor ${index}`, date,
  time: `${18+index}:00`, timeStatus: 'confirmed', timeSource: 'caption' }));
const source = [...events,{...events[0],_id:'differentday1',date:'2026-10-14'}];
const payload = buildDailyReelPayload({events:source,publishDate:'2026-10-14',publicOrigin:'https://eventzeka.com'});
assert.equal(payload.eventDate,date); assert.equal(payload.selectedCount,4); assert.equal(payload.musicMode,'instagram_catalog');
assert.equal(payload.durationSeconds,18);assert.equal(payload.hasClosingCta,true);
assert.equal(new URL(payload.videoUrl).searchParams.get('publishDate'),payload.publishDate);
assert.match(new URL(payload.videoUrl).searchParams.get('v'),/^r5-/);
assert.equal(payload.locationName,'Belgrade, Serbia'); assert.ok(payload.caption.includes('Sutra') || payload.caption.includes('sutra'));
const carousel=selectDailyCarouselEvents(events,'2026-10-14',3,[date]);
assert.ok(payload.eventIds.every(id=>!carousel.some(event=>event._id===id)),'Reel excludes the carousel programme');
assert.equal(payload.selectionPolicy,'prefer_unposted');
const extra=events.find(event=>!carousel.some(posted=>posted._id===event._id));
const postedCaption=buildDailyCarouselCaption([extra],'https://eventzeka.com',[date]);
const withHistory=buildDailyReelPayload({events:source,publishDate:'2026-10-14',publicOrigin:'https://eventzeka.com',publishedCaptions:[postedCaption]});
assert.ok(!withHistory.eventIds.includes(extra._id),'actual published captions override changes in the carousel selection');
const longExtra={...extra,title:'Dug naziv programa '.repeat(8).trim(),venue:'Dug naziv prostora '.repeat(4).trim()};
const longHistory=buildDailyReelPayload({events:events.map(event=>event._id===extra._id?longExtra:event),publishDate:'2026-10-14',publicOrigin:'https://eventzeka.com',publishedCaptions:[buildDailyCarouselCaption([longExtra],'https://eventzeka.com',[date])]});
assert.ok(!longHistory.eventIds.includes(extra._id),'match full event identities when existing carousel captions truncate their display');
const otherDayCaption=buildDailyCarouselCaption([{...extra,date:'2026-10-16'},carousel[0]],'https://eventzeka.com',[date,'2026-10-16']);
const otherDay=buildDailyReelPayload({events:source,publishDate:'2026-10-14',publicOrigin:'https://eventzeka.com',publishedCaptions:[otherDayCaption]});
assert.ok(!otherDay.excludedEventIds.includes(extra._id),'another occurrence on another carousel day is not the same event');
const sparse=buildDailyReelPayload({events:events.slice(0,3),publishDate:'2026-10-14',publicOrigin:'https://eventzeka.com'});
assert.equal(sparse.selectedCount,3,'a sparse day fills its programme with repeats only after unseen choices');
assert.equal(sparse.repeatedEventIds.length,3);
const allPosted=buildDailyReelPayload({events,publishDate:'2026-10-14',publicOrigin:'https://eventzeka.com',excludedEventIds:events.map(event=>event._id)});
assert.equal(allPosted.selectedCount,0);
assert.ok(payload.caption.includes('Jo\u0161 doga\u0111aja: eventzeka.com.'));
assert.deepEqual(payload,buildDailyReelPayload({events:[...source].reverse(),publishDate:'2026-10-14',publicOrigin:'https://eventzeka.com'}));
assert.equal(buildDailyReelPayload({events:[source.at(-1)],publishDate:'2026-10-14',publicOrigin:'https://eventzeka.com'}).videoUrl,null);
assert.equal(buildDailyReelPayload({events:[],publishDate:'2026-12-31',publicOrigin:'https://eventzeka.com'}).eventDate,'2027-01-01');
const selected = payload.eventIds.map(id=>events.find(event=>event._id===id));
assert.equal(new Set(selected.map(event=>event._id)).size,4);
const artwork=buildPosterArtwork({date,events:selected,position:0,format:'reel'}),fourRows=artwork.rows;
assert.ok(!artwork.bounds.some(bound=>bound.role==='intro'),'Reel runs straight from the date into events');
assert.doesNotMatch(artwork.svg.toString(),/data-role="intro"/u);
assert.equal(fourRows.length,4); assert.ok(Math.abs(fourRows.at(-1).top+fourRows.at(-1).height-1455)<0.01);
assert.ok(fourRows.every(row=>row.height>=146 && row.venueTop+row.venue.height<=row.top+row.height));
assert.throws(()=>buildAgendaPosterSvg({date,events:selected,position:0}),/one to three/,'feed still allows only three events');
assert.equal((buildAgendaPosterSvg({date,events:selected,position:0,format:'story'}).toString().match(/class="time-label"/g)||[]).length,4,'Story also allows four events');
const appendedEvents=events.map(event=>({...event,date:'2026-11-15'}));
const appended=buildDailyReelPayload({events:appendedEvents,publishDate:'2026-11-14',publicOrigin:'https://eventzeka.com'});
assert.deepEqual([appended.design.id,appended.design.cycleLength,appended.selectedCount,appended.eventDate],['27',81,4,'2026-11-15']);
assert.equal(appended.musicMode,'instagram_catalog');assert.equal(appended.locationName,'Belgrade, Serbia');
const appendedArt=buildPosterArtwork({date:appended.eventDate,events:appended.eventIds.map(id=>appendedEvents.find(event=>event._id===id)),position:0,format:'reel',publishDate:appended.publishDate});
assert.equal(appendedArt.theme.id,'27');assert.equal(appendedArt.rows.length,4);
assert.equal((appendedArt.svg.toString().match(/width="168" height="108"/g)||[]).length,4);
assert.doesNotMatch(appendedArt.svg.toString(),/data-role="intro"/u);
assert.equal(new URL(appended.videoUrl).searchParams.get('v'),new URL(appended.coverUrl).searchParams.get('v'),'new-family cover and video share exact fact/design version');
const temporary = await mkdtemp(path.join(os.tmpdir(),'qa-eventzeka-reel-'));
const originalCache = process.env.EVENTZEKA_REEL_CACHE_DIR;
process.env.EVENTZEKA_REEL_CACHE_DIR=temporary;
const originals = { secret:process.env.CRON_SECRET, convex:process.env.NEXT_PUBLIC_CONVEX_URL, query:ConvexHttpClient.prototype.query };
try {
  const cover = await renderReelCover(date,selected);
  const metadata = await sharp(cover).metadata();
  assert.deepEqual([metadata.width,metadata.height,metadata.format],[1080,1920,'jpeg']);
  assert.ok(artwork.bounds.every(b=>b.x>=48&&b.x+b.width<=938&&b.y>=226&&b.y+b.height<=1560),'Reel text avoids controls; illustration can bleed');
  const [video, concurrent] = await Promise.all([renderDailyReel(date,selected),renderDailyReel(date,selected)]);
  assert.deepEqual(video,concurrent); assert.deepEqual(video,await renderDailyReel(date,selected));
  const file = path.join(temporary,'probe.mp4'); await writeFile(file,video);
  const probe = JSON.parse((await exec('ffprobe',['-v','error','-show_format','-show_streams','-of','json',file])).stdout);
  const stream = probe.streams.find(stream=>stream.codec_type==='video');
  assert.deepEqual([stream.codec_name,stream.width,stream.height,stream.pix_fmt,stream.avg_frame_rate],['h264',1080,1920,'yuv420p','30/1']);
  const audio=probe.streams.find(stream=>stream.codec_type==='audio');
  assert.deepEqual([audio.codec_name,audio.sample_rate,audio.channels],['aac','48000',2]);
  assert.ok(Math.abs(Number(probe.format.duration)-18)<0.1);assert.equal(Number(stream.nb_frames),540); assert.ok(video.length<100_000_000);
  await exec('ffmpeg',['-v','error','-xerror','-i',file,'-f','null','-'],{timeout:60000,maxBuffer:100000});
  assert.ok(video.indexOf(Buffer.from('moov'))<video.indexOf(Buffer.from('mdat')),'MP4 supports fast start');
  for (const [time,name] of [['0.2','before.png'],['2','after.png']]) await exec('ffmpeg',['-hide_banner','-loglevel','error','-y','-ss',time,'-i',file,'-frames:v','1',path.join(temporary,name)]);
  const before = await sharp(await readFile(path.join(temporary,'before.png'))).extract({left:72,top:700,width:855,height:160}).raw().toBuffer();
  const after = await sharp(await readFile(path.join(temporary,'after.png'))).extract({left:72,top:700,width:855,height:160}).raw().toBuffer();
  assert.notDeepEqual(before,after,'programme entries reveal within the opening seconds');
  const fourthArea={left:72,top:Math.ceil(fourRows[3].top)+20,width:855,height:100};
  assert.notDeepEqual(await sharp(await readFile(path.join(temporary,'before.png'))).extract(fourthArea).raw().toBuffer(),
    await sharp(await readFile(path.join(temporary,'after.png'))).extract(fourthArea).raw().toBuffer(),'fourth event is revealed within the first two seconds');
  const ending=[];
  for(const t of [15,17]){const{stdout:png}=await exec('ffmpeg',['-v','error','-ss',String(t),'-i',file,'-frames:v','1','-f','image2pipe','-vcodec','png','-'],{encoding:'buffer',maxBuffer:12000000});ending.push(await sharp(png).extract({left:0,top:1740,width:1080,height:180}).resize(360,60).removeAlpha().raw().toBuffer());}
  let movingPixels=0;for(let i=0;i<ending[0].length;i+=3)if(Math.max(...[0,1,2].map(channel=>Math.abs(ending[0][i+channel]-ending[1][i+channel])))>12)movingPixels++;
  assert.ok(movingPixels/(360*60)>.01,'Reel CTA background continues animating through the final hold');
  assert.equal(reelVideoResponse(video,new Request('https://eventzeka.com', {headers:{range:'bytes=0-99'}})).status,206);
  assert.equal((await reelVideoResponse(video,new Request('https://eventzeka.com', {headers:{range:'bytes=-99'}})).arrayBuffer()).byteLength,99);
  assert.equal(reelVideoResponse(video,new Request('https://eventzeka.com', {headers:{range:'bytes=999999999-'}})).status,416);
  assert.equal((await reelVideoResponse(video,new Request('https://eventzeka.com',{method:'HEAD'})).arrayBuffer()).byteLength,0);

  process.env.CRON_SECRET='qa-reels-secret'; process.env.NEXT_PUBLIC_CONVEX_URL='https://qa-reels.convex.cloud';
  const request = suffix=>new Request(`https://eventzeka.com/api/social/daily-reels${suffix}`,{headers:{authorization:'Bearer qa-reels-secret'}});
  assert.equal((await getPayload(new Request('https://eventzeka.com/api/social/daily-reels'))).status,401);
  assert.equal((await getPayload(request('?date=2026-02-29'))).status,400);
  const calls=[];
  ConvexHttpClient.prototype.query=async(_,args)=>{calls.push(args);return args.cursor===null ? {page:source.slice(0,2),isDone:false,continueCursor:'next'}:{page:source.slice(2),isDone:true,continueCursor:''};};
  assert.deepEqual(await (await getPayload(request('?date=2026-10-14'))).json(),payload);
  assert.deepEqual(await (await postPayload(new Request('https://eventzeka.com/api/social/daily-reels?date=2026-10-14',{method:'POST',headers:{authorization:'Bearer qa-reels-secret','content-type':'application/json'},body:JSON.stringify({publishedCaptions:[postedCaption],excludedEventIds:[]})}))).json(),withHistory);
  assert.equal((await postPayload(new Request('https://eventzeka.com/api/social/daily-reels',{method:'POST',body:'{}'}))).status,401);
  assert.equal((await postPayload(new Request('https://eventzeka.com/api/social/daily-reels',{method:'POST',headers:{authorization:'Bearer qa-reels-secret'},body:JSON.stringify({publishedCaptions:[],excludedEventIds:['invalid!']})}))).status,400);
  assert.ok(calls.every(call=>call.fromDate===date && call.beforeDate==='2026-10-16'));
  ConvexHttpClient.prototype.query=async()=>({page:[events[0]],isDone:false,continueCursor:'same'});
  assert.equal((await getPayload(request('?date=2026-10-14'))).status,503);
  const context={params:Promise.resolve({date})};
  const oversized=new URL(payload.coverUrl); oversized.searchParams.set('events',events.slice(0,5).map(event=>event._id).join(','));
  assert.equal((await getVideo(new Request(oversized),context)).status,400,'five-event Reels remain invalid');
  ConvexHttpClient.prototype.query=async(_,args)=>({...events.find(event=>event._id===args.id),status:'approved'});
  assert.equal((await getVideo(new Request(payload.coverUrl),context)).status,200);
  for(const change of [{publishDate:'2026-02-29'},{publishDate:''},{cover:'2'}]){
    const invalid=new URL(payload.coverUrl);for(const[key,value]of Object.entries(change))invalid.searchParams.set(key,value);
    assert.equal((await getVideo(new Request(invalid),context)).status,400);
  }
  for(const parameter of ['publishDate','cover']){
    const duplicate=new URL(payload.coverUrl);duplicate.searchParams.append(parameter,duplicate.searchParams.get(parameter));
    assert.equal((await getVideo(new Request(duplicate),context)).status,400);
  }
  const mismatchedDay=new URL(payload.coverUrl);mismatchedDay.searchParams.set('publishDate','2026-10-13');
  assert.equal((await getVideo(new Request(mismatchedDay),context)).status,400,'a Reel must belong to the day after publication');
  assert.notEqual(buildReelRenderVersion(date,selected,payload.publishDate),buildReelRenderVersion(date,selected,'2026-10-13'));
  const legacyCover=new URL(payload.coverUrl);legacyCover.searchParams.delete('publishDate');
  assert.equal((await getVideo(new Request(legacyCover),context)).status,200,'a legacy link infers the conventional publication day');
  const stale=new URL(payload.videoUrl); stale.searchParams.set('v','r2-stale');
  assert.equal((await getVideo(new Request(stale),context)).status,409);
  ConvexHttpClient.prototype.query=async(_,args)=>({...events.find(event=>event._id===args.id),status:'pending'});
  assert.equal((await getVideo(new Request(payload.videoUrl),context)).status,404,'cached video still checks moderation');
  ConvexHttpClient.prototype.query=async(_,args)=>({...events.find(event=>event._id===args.id),status:'approved',time:'23:59'});
  assert.equal((await getVideo(new Request(payload.videoUrl),context)).status,409,'cached video still checks exact displayed facts');
} finally {
  ConvexHttpClient.prototype.query=originals.query;
  for (const [key,value] of [['CRON_SECRET',originals.secret],['NEXT_PUBLIC_CONVEX_URL',originals.convex],['EVENTZEKA_REEL_CACHE_DIR',originalCache]]) {
    if(value===undefined) delete process.env[key]; else process.env[key]=value;
  }
  await rm(temporary,{recursive:true,force:true});
}
console.log('Daily Reel QA passed: tomorrow-only programme, native 18-second material animation with living CTA, safe areas, ranges, publication-bound versions/cache and moderation checks.');
