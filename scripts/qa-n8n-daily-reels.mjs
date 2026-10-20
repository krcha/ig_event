import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { publishEventZekaReel } from '../ops/n8n/publish-daily-reels.mjs';
import { assertSocialPublicationResult } from '../ops/n8n/social-publication-result.mjs';

const env={EVENTZEKA_API_ORIGIN:'https://eventzeka.com',EVENTZEKA_CRON_SECRET:'secret',EVENTZEKA_REELS_FB_ACCESS_TOKEN:'private-fb-token',EVENTZEKA_REELS_IG_USER_ID:'111',EVENTZEKA_REELS_LOCATION_ID:'222'};
const payload={publishDate:'2026-10-14',eventDate:'2026-10-15',selectionKey:'test',selectedCount:4,eventIds:['event1','event2','event3','event4'],
  selectionPolicy:'prefer_unposted',repeatedEventIds:[],excludedEventIds:['posted1'],
  videoUrl:'https://eventzeka.com/api/social/reels/days/2026-10-15?events=event1,event2,event3,event4&v=r5-test&publishDate=2026-10-14',
  coverUrl:'https://eventzeka.com/api/social/reels/days/2026-10-15?events=event1,event2,event3,event4&v=r5-test&publishDate=2026-10-14&cover=1',caption:'Za sutra u Beogradu.',durationSeconds:18,hasClosingCta:true,locationName:'Belgrade, Serbia',musicMode:'instagram_catalog'};
function setup(options={}) {
  const state=options.state || {}; const calls=[]; let published=0;
  const httpRequest=async request=>{
    calls.push(request);
    if(request.url.includes('/daily-reels')) return {statusCode:200,body:options.payload || payload};
    if(request.method==='HEAD') return {statusCode:options.badVideo?409:200,headers:{'content-type':request.url.includes('cover=1')?'image/jpeg':'video/mp4','accept-ranges':options.noRanges?'none':'bytes'}};
    if(request.headers?.Range) return {statusCode:options.badRange?200:206,headers:{'content-type':'video/mp4','content-range':'bytes 0-31/65536'},body:new Uint8Array(32)};
    if(request.url.includes('/media?fields=caption,timestamp')) return {statusCode:options.badHistory?500:200,body:options.badHistory?{error:{message:'History unavailable'}}:{data:[{caption:'Published programme',timestamp:'2026-10-14T16:30:00+0000'}]}};
    if(request.url.includes('/ig_audio?')) return {statusCode:200,body:{audio:options.emptyMusic?[]:(options.tracks || [{audio_id:'333',title:'Prva',duration_in_ms:60000,audio_type:'music'},{audio_id:'444',title:'Druga',duration_in_ms:60000,audio_type:'music'}])}};
    if(request.url.endsWith('/media')) return {statusCode:options.badLocation?400:200,body:options.badLocation?{error:{message:'Invalid location'}}:{id:'container'}};
    if(request.url.includes('?fields=status_code,status')) return {statusCode:200,body:{status_code:'FINISHED'}};
    if(request.url.endsWith('/media_publish')) {published++;if(options.ambiguous) throw new Error(`Connection lost ${env.EVENTZEKA_REELS_FB_ACCESS_TOKEN}`);return {statusCode:200,body:options.missingId?{}:{id:'reel'}};}
    throw new Error('Unexpected request');
  };
  return {state,calls,httpRequest,get published(){return published;},run:override=>publishEventZekaReel({env:{...env,...override},httpRequest,getStaticData:()=>state,
    now:options.now || (()=>new Date('2026-10-14T17:30:00Z')),random:options.random || (()=>0)})};
}
let test=setup({state:{lastAudioId:'333'}}); let result=(await test.run())[0].json;
assert.equal(result.status,'published'); assert.equal(result.selectedCount,4); assert.deepEqual(test.state.lastEventIds,payload.eventIds); assert.equal(result.audioId,'444'); assert.equal(test.published,1);
assert.equal(result.durationSeconds,18);assert.equal(result.hasClosingCta,true);
const created=new URLSearchParams(test.calls.find(call=>call.url.endsWith('/media')).body);
assert.equal(created.get('media_type'),'REELS'); assert.equal(created.get('location_id'),'222'); assert.equal(created.get('share_to_feed'),'false');
assert.deepEqual(JSON.parse(created.get('audio_configuration')),{audio_id:'444',audio_volume:80,video_volume:1});
assert.equal(created.get('video_url'),payload.videoUrl);assert.equal(created.get('cover_url'),payload.coverUrl);
assert.ok(test.calls.filter(call=>call.method==='HEAD'||call.headers?.Range).every(call=>call.timeout>=360000),'uncached native video preflight has at least six minutes');
assert.equal(test.calls.filter(call=>call.headers?.Range==='bytes=0-31').length,1);
const generated=test.calls.find(call=>call.url.includes('/daily-reels'));
assert.equal(generated.method,'POST'); assert.deepEqual(JSON.parse(generated.body).publishedCaptions,['Published programme']);
assert.ok(test.calls.filter(call=>call.url.includes('graph.')).every(call=>call.url.startsWith('https://graph.facebook.com/')));
assert.equal((await test.run())[0].json.status,'skipped_already_published'); assert.equal(test.published,1);
test=setup(); result=(await test.run({EVENTZEKA_SOCIAL_DRY_RUN:'true',EVENTZEKA_REELS_FB_ACCESS_TOKEN:''}))[0].json;
assert.equal(result.status,'dry_run'); assert.equal(test.calls.filter(call=>call.method==='HEAD').length,2); assert.deepEqual(test.state,{}); assert.equal(test.published,0);
test=setup(); assert.equal((await test.run({EVENTZEKA_REELS_FB_ACCESS_TOKEN:''}))[0].json.status,'blocked_facebook_login_required');
test=setup(); assert.equal((await test.run({EVENTZEKA_REELS_LOCATION_ID:''}))[0].json.status,'blocked_belgrade_location_required');
test=setup({payload:{...payload,eventDate:'2026-10-14'}}); await assert.rejects(test.run(),/tomorrow/); assert.equal(test.published,0);
test=setup({badVideo:true}); await assert.rejects(test.run(),/preflight/); assert.equal(test.published,0);
for(const options of [{badRange:true},{noRanges:true}]){test=setup(options);await assert.rejects(test.run(),/preflight/);assert.equal(test.published,0);assert.deepEqual(test.state,{});}
test=setup(); assert.equal((await test.run({EVENTZEKA_API_ORIGIN:'https://events.ineedtofeedmyrabbit.com',EVENTZEKA_SOCIAL_DRY_RUN:'true'}))[0].json.status,'dry_run','internal API origin can differ from public media origin');
test=setup({badLocation:true}); await assert.rejects(test.run(),/Invalid location/); assert.equal(test.published,0);
test=setup({badHistory:true}); await assert.rejects(test.run(),/verify recent publication history/); assert.equal(test.published,0);
test=setup({payload:{...payload,selectedCount:5,eventIds:[...payload.eventIds,'event5']}}); await assert.rejects(test.run(),/Invalid exact-image/); assert.equal(test.published,0);
test=setup({payload:{...payload,excludedEventIds:['event1']}}); await assert.rejects(test.run(),/Invalid exact-image/); assert.equal(test.published,0);
const tracks=['First','First','Second','Third','Old classic'].map((title,index)=>({audio_id:String(700+index),title,display_artist:'Artist',duration_in_ms:60000,audio_type:'music'}));
test=setup({tracks:[{audio_id:'777',title:'Too short',duration_in_ms:17999,audio_type:'music'},{audio_id:'778',title:'Full eighteen',duration_in_ms:18000,audio_type:'music'}]});
result=(await test.run())[0].json;assert.equal(result.audioId,'778','catalog selection covers the complete 18-second Reel and CTA');
test=setup({tracks:[{audio_id:'777',title:'Too short',duration_in_ms:17999,audio_type:'music'}]});assert.equal((await test.run())[0].json.status,'blocked_no_catalog_music');assert.equal(test.published,0);
test=setup({tracks,random:()=>0.999});result=(await test.run())[0].json;
assert.equal(result.audioTitle,'Third');assert.equal(result.audioCatalogRank,4,'duplicate versions do not push an old track into the top three distinct trending songs');
test=setup({tracks,state:{lastAudioTitle:'First',lastAudioArtist:'Artist',lastAudioId:'999'}});result=(await test.run())[0].json;assert.equal(result.audioTitle,'Second','avoid the same song under a different audio ID');
test=setup({state:{lastPublishDate:'2026-10-14',lastReelId:'older-reel',lastSelectionKey:'2026-10-14:reel:2026-10-15:abcdefghijk1,abcdefghijk2@r4-test'}});
result=(await test.run({EVENTZEKA_REEL_REPLACE_ID:'older-reel'}))[0].json;
assert.equal(result.replacesReelId,'older-reel');assert.equal(test.state.previousPublications[0].lastReelId,'older-reel');
assert.deepEqual(JSON.parse(test.calls.find(call=>call.url.includes('/daily-reels')).body).excludedEventIds,['abcdefghijk1','abcdefghijk2']);
assert.equal((await test.run())[0].json.status,'skipped_already_published');
test=setup({state:{lastPublishDate:'2026-10-14',lastReelId:'actual-reel'}});await assert.rejects(test.run({EVENTZEKA_REEL_REPLACE_ID:'wrong-reel'}),/Replacement/);
test=setup({emptyMusic:true}); assert.equal((await test.run())[0].json.status,'blocked_no_catalog_music'); assert.equal(test.published,0);
test=setup({ambiguous:true}); result=(await test.run())[0].json;
assert.equal(result.status,'blocked_reconciliation_required'); assert.equal(test.published,1); assert.ok(test.state.pending); assert.ok(!JSON.stringify(test.state).includes('private-fb-token'));
const saved=structuredClone(test.state);
let next=setup({state:saved,now:()=>new Date('2026-10-15T17:30:00Z')}); assert.equal((await next.run())[0].json.status,'blocked_reconciliation_required'); assert.equal(next.calls.length,0);
delete saved.pending; next=setup({state:saved}); assert.equal((await next.run())[0].json.status,'published');
assert.equal(next.calls.filter(call=>call.url.includes('/ig_audio?') || call.url.endsWith('/media')).length,0,'confirmed unpublished preparation keeps its music and container');
test=setup({missingId:true}); assert.equal((await test.run())[0].json.status,'blocked_reconciliation_required'); assert.equal(test.published,1);
test=setup({payload:{...payload,selectedCount:0,eventIds:[],videoUrl:null,coverUrl:null}}); assert.equal((await test.run())[0].json.status,'skipped_no_events');
for(const [day,nextDay,instant] of [['2026-10-26','2026-10-27','2026-10-26T18:30:00Z'],['2026-12-31','2027-01-01','2026-12-31T18:30:00Z']]) {
  test=setup({payload:{...payload,publishDate:day,eventDate:nextDay,videoUrl:payload.videoUrl.replaceAll('2026-10-15',nextDay).replaceAll('publishDate=2026-10-14',`publishDate=${day}`),coverUrl:payload.coverUrl.replaceAll('2026-10-15',nextDay).replaceAll('publishDate=2026-10-14',`publishDate=${day}`)},now:()=>new Date(instant)});
  assert.equal((await test.run({EVENTZEKA_SOCIAL_DRY_RUN:'true'}))[0].json.eventDate,nextDay);
}
for(const change of [
 {durationSeconds:15},{hasClosingCta:false},{videoUrl:payload.videoUrl.replace('r5-','r4-')},
 {videoUrl:payload.videoUrl.replace('publishDate=2026-10-14','publishDate=2026-10-15')},
 {videoUrl:payload.videoUrl+'&publishDate=2026-10-15'}, {coverUrl:payload.coverUrl.replace('cover=1','cover=0')},
]){
  const state={unrelated:{keep:'receipt'}};const before=structuredClone(state);test=setup({state,payload:{...payload,...change}});
  await assert.rejects(test.run(),/18-second closing CTA/);assert.equal(test.published,0);assert.deepEqual(state,before);
}
const opaqueState={pending:{publishDate:'2026-10-13',containerId:'exact-unknown',selectionKey:'saved',error:'connection lost'},unrelated:{keep:['all','fields']}};
const opaqueBefore=structuredClone(opaqueState);test=setup({state:opaqueState});
assert.equal((await test.run())[0].json.status,'blocked_reconciliation_required');assert.equal(test.calls.length,0);assert.deepEqual(opaqueState,opaqueBefore);
const legacyPreparation={prepared:{...payload,durationSeconds:15,hasClosingCta:false,audioId:'333',containerId:'old-container'},unrelated:{keep:true}};
const legacyBefore=structuredClone(legacyPreparation);test=setup({state:legacyPreparation});
await assert.rejects(test.run(),/18-second closing CTA/);assert.equal(test.calls.length,0);assert.deepEqual(legacyPreparation,legacyBefore,'legacy preparation fails closed without changing any receipt');
const [workflow]=JSON.parse(readFileSync(new URL('../ops/n8n/event-zeka-daily-reels.json',import.meta.url)));
assert.equal(workflow.active,false); assert.equal(workflow.settings.timezone,'Europe/Belgrade');
assert.equal(workflow.nodes.find(node=>node.type==='n8n-nodes-base.scheduleTrigger').parameters.rule.interval[0].expression,'30 19 * * *');

assert.equal(workflow.settings.executionTimeout,900,'publication deadline stays below catch-up spacing');
assert.deepEqual(workflow.nodes.find(candidate=>candidate.type==='n8n-nodes-base.scheduleTrigger').parameters.rule.interval.map(item=>item.expression),['30 19 * * *', '0 20 * * *', '30 20 * * *']);
const resultNode=workflow.nodes.find(candidate=>candidate.id==='verify-publication-result');
assert.ok(resultNode,'publication result is verified in a separate node');
assert.ok(resultNode.parameters.jsCode.startsWith(assertSocialPublicationResult.toString()));
assert.ok(resultNode.parameters.jsCode.includes('return assertSocialPublicationResult($input.all());'));
const publicationNodeForCheck=workflow.nodes.find(candidate=>candidate.type==='n8n-nodes-base.code'&&candidate.id!==resultNode.id);
assert.equal(workflow.connections[publicationNodeForCheck.name].main[0][0].node,resultNode.name);
const scheduledNodeForCheck=workflow.nodes.find(candidate=>candidate.type==='n8n-nodes-base.scheduleTrigger');
assert.equal(workflow.connections[scheduledNodeForCheck.name].main[0][0].node,publicationNodeForCheck.name);
const manualNodeForCheck=workflow.nodes.find(candidate=>candidate.type==='n8n-nodes-base.manualTrigger');
assert.equal(workflow.connections[manualNodeForCheck.name].main[0][0].node,publicationNodeForCheck.name);
for(const status of ['published','dry_run','skipped_already_published','skipped_no_events','skipped_special_publication_day']){
  const input=[{json:{status,receipt:'unchanged'}}];
  const resultContext=vm.createContext({$input:{all:()=>input}});
  const verified=await new vm.Script('(async()=>{'+resultNode.parameters.jsCode+'})()').runInContext(resultContext);
  assert.equal(verified,input,'result verification preserves the complete publisher output');
}
const blockedResultContext=vm.createContext({$input:{all:()=>[{json:{status:'blocked_reconciliation_required',reason:'reconcile exact pending receipt'}}]}});
await assert.rejects(new vm.Script('(async()=>{'+resultNode.parameters.jsCode+'})()').runInContext(blockedResultContext),/Social publication failed/);

const code=workflow.nodes.find(node=>node.type==='n8n-nodes-base.code').parameters.jsCode;
assert.ok(code.startsWith(publishEventZekaReel.toString()));
assert.ok(!code.includes(assertSocialPublicationResult.toString()),'publisher returns state before result verification');assert.ok(code.includes('return await publishEventZekaReel('));
test=setup(); const context=vm.createContext({$env:env,$execution:{mode:'manual'},helpers:{httpRequest:test.httpRequest},
  Date:class extends Date { constructor(value='2026-10-14T17:30:00Z'){super(value);} },
  $getWorkflowStaticData:()=>{throw new Error('Manual previews cannot access state');},URL:undefined,URLSearchParams:undefined});
assert.equal((await new vm.Script(`(async()=>{${code}})()`).runInContext(context))[0].json.status,'dry_run'); assert.equal(test.published,0);
console.log('n8n Reel QA passed: 19:30 Belgrade, tomorrow-only, required 18-second CTA and music range, exact MP4/cover/range preflight, native sandbox, live failure wrapper and unchanged ambiguous/prepared publication receipts.');
