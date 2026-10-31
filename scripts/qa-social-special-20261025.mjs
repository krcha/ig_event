import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import sharp from 'sharp';
import {publishEventZekaCarousel} from '../ops/n8n/publish-daily-carousel.mjs';
import {publishEventZekaStories} from '../ops/n8n/publish-daily-stories.mjs';
import {publishEventZekaReel} from '../ops/n8n/publish-daily-reels.mjs';
import {publishEventZekaSpecial} from '../ops/n8n/publish-special-20261025.mjs';
import {GET,HEAD} from '../app/api/social/special/2026-10-25/[asset]/route.ts';

const plan=JSON.parse(readFileSync(new URL('../public/social/special/2026-10-25/manifest.json',import.meta.url)));
const env={EVENTZEKA_IG_USER_ID:'111',EVENTZEKA_IG_ACCESS_TOKEN:'private-ig',EVENTZEKA_REELS_IG_USER_ID:'222',EVENTZEKA_REELS_FB_ACCESS_TOKEN:'private-fb',EVENTZEKA_CRON_SECRET:'private-cron'};
const successResponse=body=>({statusCode:200,body});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
assert.equal(sha(readFileSync('public/social/special/2026-10-25/source.png')),plan.sourceSha256);
assert.equal(plan.caption,'Iza\u0111i i glasaj!');
assert.equal(new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Belgrade',hour:'2-digit',minute:'2-digit'}).format(new Date(plan.scheduledUtc)),'10:00');
for(const asset of Object.values(plan.assets)){
  const bytes=readFileSync('public/social/special/2026-10-25/'+asset.file);
  assert.equal(bytes.length,asset.bytes);assert.equal(sha(bytes),asset.sha256);
  const request=new Request(asset.url);
  const context={params:Promise.resolve({asset:asset.file})};
  const response=await GET(request,context);
  assert.equal(response.status,200);assert.equal(response.headers.get('x-content-sha256'),asset.sha256);
  assert.equal(sha(Buffer.from(await response.arrayBuffer())),asset.sha256);
  const head=await HEAD(new Request(asset.url,{method:'HEAD'}),context);
  assert.equal(head.headers.get('content-length'),String(asset.bytes));assert.equal((await head.arrayBuffer()).byteLength,0);
  const stale=await GET(new Request(asset.url.replace(asset.sha256,'0'.repeat(64))),context);assert.equal(stale.status,409);
}
for(const [key,width,height] of [['post',1080,1350],['story',1080,1920],['cover',1080,1920]]){
  const image=await sharp('public/social/special/2026-10-25/'+plan.assets[key].file).metadata();
  assert.deepEqual([image.format,image.width,image.height],['jpeg',width,height]);
}
assert.equal((await GET(new Request(plan.assets.post.url),{params:Promise.resolve({asset:'source.png'})})).status,404);
assert.equal((await GET(new Request(plan.assets.post.url.split('?')[0]),{params:Promise.resolve({asset:'post.jpg'})})).status,400);
const range=await GET(new Request(plan.assets.reel.url,{headers:{range:'bytes=0-99'}}),{params:Promise.resolve({asset:'reel.mp4'})});
assert.equal(range.status,206);assert.equal((await range.arrayBuffer()).byteLength,100);

for(const publisher of [publishEventZekaCarousel,publishEventZekaStories,publishEventZekaReel]){
  for(const instant of ['2026-10-24T22:00:00Z','2026-10-25T00:59:59Z','2026-10-25T01:00:00Z','2026-10-25T09:00:00Z','2026-10-25T22:59:59Z']){
    const result=await publisher({env:{},now:()=>new Date(instant),getStaticData:()=>{throw new Error('Blackout accessed publication state');},httpRequest:()=>{throw new Error('Blackout made a network request');}});
    assert.equal(result[0].json.status,'skipped_special_publication_day');
  }
  for(const instant of ['2026-10-24T21:59:59Z','2026-10-25T23:00:00Z','2026-10-26T09:00:00Z','2027-10-25T09:00:00Z']){
    await assert.rejects(publisher({env:{},now:()=>new Date(instant),getStaticData:()=>({}),httpRequest:()=>{throw new Error('Regular request');}}),/configuration|configured/,'Regular execution must resume outside the exact year/date.');
  }
}
function setup(options={}){
  const state=options.state||{},calls=[];let sequence=0,publishes=0;
  const httpRequest=async request=>{
    calls.push(request);
    if(request.method==='HEAD'){
      const asset=Object.values(plan.assets).find(asset=>asset.url===request.url);assert(asset);
      return {statusCode:options.badMedia?409:200,headers:{'content-type':asset.contentType,'content-length':String(asset.bytes),'x-content-sha256':asset.sha256}};
    }
    if(request.url.includes('/content_publishing_limit?'))return successResponse({data:[{quota_usage:options.exhausted?99:3,config:{quota_total:100,quota_duration:86400}}]});
    if(request.url.includes('/ig_audio?'))return successResponse({audio:options.noAudio?[]:[{audio_id:'333',title:'Live trending track',display_artist:'Artist',duration_in_ms:60000}]});
    if(request.url.endsWith('/media'))return successResponse({id:'container-'+(++sequence)});
    if(request.url.includes('?fields=status_code,status'))return successResponse({status_code:options.badContainer?'ERROR':'FINISHED'});
    if(request.url.endsWith('/media_publish')){
      publishes++;
      if(options.ambiguous)throw new Error('Transport lost private-fb private-ig private-cron');
      return successResponse(options.missingId?{}:{id:'published-'+publishes});
    }
    throw new Error('Unexpected request: '+request.url);
  };
  const run=(format='post',extra={})=>publishEventZekaSpecial({env,httpRequest,getStaticData:()=>state,plan,format,now:options.now||(()=>new Date('2026-10-25T09:00:00Z')),random:()=>0,...extra});
  return {state,calls,httpRequest,run,get publishes(){return publishes;}};
}
for(const instant of ['2026-10-24T09:00:00Z','2026-10-25T23:00:00Z','2027-10-25T09:00:00Z']){
  const test=setup({now:()=>new Date(instant)});assert.equal((await test.run())[0].json.status,'skipped_outside_special_date');assert.equal(test.calls.length,0);assert.deepEqual(test.state,{});
}
let test=setup({now:()=>new Date('2026-10-25T08:59:59Z')});assert.equal((await test.run())[0].json.status,'skipped_before_special_time');assert.equal(test.calls.length,0);
test=setup();
for(const format of ['post','story','reel'])assert.equal((await test.run(format))[0].json.status,'published');
assert.equal(test.publishes,3);assert.equal(test.state.specialPublications[plan.id].completed,true);
const creations=test.calls.filter(call=>call.url.endsWith('/media')).map(call=>Object.fromEntries(new URLSearchParams(call.body)));
assert.equal(creations[0].caption,plan.caption);assert.equal(creations[0].media_type,undefined);
assert.equal(creations[1].media_type,'STORIES');assert.equal(creations[1].caption,undefined);
assert.equal(creations[2].media_type,'REELS');assert.equal(creations[2].caption,plan.caption);assert.equal(creations[2].share_to_feed,'false');
assert.equal(JSON.parse(creations[2].audio_configuration).audio_id,'333');
assert(creations.every(body=>body.location_id===plan.locationId&&!body.user_tags));
const count=test.calls.length;
for(const format of ['post','story','reel'])assert.equal((await test.run(format))[0].json.status,'skipped_already_published');
assert.equal(test.calls.length,count);assert.equal(test.publishes,3);
for(const option of ['badMedia','badContainer','exhausted','noAudio']){
  test=setup({[option]:true});assert.equal((await test.run())[0].json.status,'blocked_special_preparation');assert.equal(test.publishes,0);
}
test=setup();assert.equal((await test.run('story'))[0].json.status,'blocked_previous_format_required');assert.equal(test.calls.length,0);
test=setup({ambiguous:true});assert.equal((await test.run())[0].json.status,'blocked_reconciliation_required');
assert.equal(test.publishes,1);const pending=structuredClone(test.state);
for(const format of ['post','story','reel'])assert.equal((await test.run(format))[0].json.continue,false);
assert.equal(test.publishes,1);assert.deepEqual(test.state,pending);assert(!JSON.stringify(test.state).includes('private-'));
test=setup({missingId:true});assert.equal((await test.run())[0].json.status,'blocked_reconciliation_required');assert.equal(test.publishes,1);
test=setup();const untouched=structuredClone(test.state);
for(const format of ['post','story','reel'])assert.equal((await test.run(format,{forceDryRun:true}))[0].json.status,'dry_run');
assert.deepEqual(test.state,untouched);assert.equal(test.publishes,0);assert(test.calls.every(call=>call.method==='HEAD'));

const [workflow]=JSON.parse(readFileSync('ops/n8n/event-zeka-special-20261025.json'));
assert.equal(workflow.active,false);assert.equal(workflow.settings.timezone,'Europe/Belgrade');assert.equal(workflow.settings.saveExecutionProgress,true);
assert.equal(workflow.nodes.find(node=>node.type==='n8n-nodes-base.scheduleTrigger').parameters.rule.interval[0].expression,'0 10 25 10 *');
for(const node of workflow.nodes.filter(node=>node.type==='n8n-nodes-base.code')){
  test=setup();const context=vm.createContext({$env:env,$execution:{mode:'manual'},helpers:{httpRequest:test.httpRequest},URL:undefined,URLSearchParams:undefined,$getWorkflowStaticData:()=>{throw new Error('Manual preview accessed state');}});
  const result=await new vm.Script(`(async()=>{${node.parameters.jsCode}})()`).runInContext(context);
  assert.equal(result[0].json.status,'dry_run');assert.equal(test.publishes,0);
}
console.log('Special publication QA passed: exact date/year, Belgrade DST, 25 October blackout, 26 October resume, pinned photo/Story/Reel media, quota, native previews, per-format receipts and ambiguous-outcome blocking.');
