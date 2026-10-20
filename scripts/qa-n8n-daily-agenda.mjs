import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { publishEventZekaCarousel } from '../ops/n8n/publish-daily-carousel.mjs';
import { assertSocialPublicationResult } from '../ops/n8n/social-publication-result.mjs';

const env = { EVENTZEKA_API_ORIGIN: 'https://api.example.test', EVENTZEKA_CRON_SECRET: 'test-cron',
  EVENTZEKA_IG_USER_ID: 'test-account', EVENTZEKA_IG_ACCESS_TOKEN: 'test-token' };
const payload = { publishDate:'2026-10-13', eventDates:['2026-10-14','2026-10-15','2026-10-16'],
  selectionKey:'agenda-v1', selectedCount:9, selectionPolicy:'prefer_unposted', repeatedEventIds:[], caption:'Program za naredna tri dana.',
  slides:[...[0,1,2].map(i => ({kind:'agenda',eventIds:[`event-${i}`],imageUrl:`https://api.example.test/agenda-${i}.jpg`,
    userTags:[{username:`venue${i}`,x:.5,y:.5}]})),{kind:'cta',imageUrl:'https://api.example.test/closing.jpg',userTags:[]}] };
function harness({state={},data=payload,imageStatus=200,publishFailure=false,publishErrorText='Ambiguous transport failure',graphFailure=null,graphFailureStage='child',tagFailure=false,dryRun=false,envOverrides={}}={}) {
  const calls=[];
  let count=0;
  const httpRequest=async options => {
    calls.push(options);
    if (options.url.endsWith('/api/social/daily-carousel')) return {statusCode:200,body:data};
    if (options.url.includes('/media?fields=caption,timestamp')) return {statusCode:200,body:{data:[]}};
    if (options.method==='HEAD') return {statusCode:imageStatus,headers:{'content-type':'image/jpeg'}};
    if (options.url.includes('/media_publish')) {
      if (graphFailure && graphFailureStage==='publish') return graphFailure;
      if (publishFailure) throw new Error(publishErrorText);
      return {statusCode:200,body:{id:'published-test'}};
    }
    if (options.url.includes('?fields=status_code,status')) return {statusCode:200,body:{status_code:'FINISHED'}};
    if (options.url.endsWith('/media') && graphFailure && (graphFailureStage==='child' ? new URLSearchParams(options.body).has('image_url') : graphFailureStage==='parent' && new URLSearchParams(options.body).get('media_type')==='CAROUSEL')) return graphFailure;
    const body=new URLSearchParams(options.body);
    if (tagFailure && body.has('user_tags')) return {statusCode:400,body:{error:{message:'Tag rejected'}}};
    return {statusCode:200,body:{id:`container-${++count}`}};
  };
  return {state,calls,run:()=>publishEventZekaCarousel({env:{...env,...(dryRun?{EVENTZEKA_SOCIAL_DRY_RUN:'true'}:{}),...envOverrides},
    httpRequest,getStaticData:()=>state,now:()=>new Date('2026-10-13T14:30:00Z')})};
}
const success=harness();
assert.equal((await success.run())[0].json.status,'published');
assert.equal(success.state.lastPublishDate,payload.publishDate);
assert.equal(success.calls.filter(c=>c.url.includes('/media_publish')).length,1);
assert.equal(success.calls.filter(c=>new URLSearchParams(c.body).has('user_tags')).length,3);
assert.equal(success.calls.filter(c=>c.method==='HEAD').length,4);
const childCreates=success.calls.filter(c=>c.method==='POST'&&new URLSearchParams(c.body).has('image_url'));
assert.equal(childCreates.length,4);
assert.equal(new URLSearchParams(childCreates.at(-1).body).get('image_url'),payload.slides.at(-1).imageUrl);
assert.ok(!new URLSearchParams(childCreates.at(-1).body).has('user_tags'), 'closing artwork has no venue tags');
const carouselCreate=success.calls.find(c=>new URLSearchParams(c.body).get('media_type')==='CAROUSEL');
assert.equal(new URLSearchParams(carouselCreate.body).get('children').split(',').length,4);
assert.equal(new URLSearchParams(carouselCreate.body).get('location_id'),'109920975697736');
assert.ok(childCreates.every(c=>!new URLSearchParams(c.body).has('location_id')), 'location belongs on the parent carousel, not its children');
assert.equal(success.state.lastLocationId,'109920975697736');
assert.ok(!success.state.pendingSelectionKey);

const changedSelection=harness({state:{lastPublishDate:payload.publishDate,lastSelectionKey:'old-version'}});
assert.equal((await changedSelection.run())[0].json.status,'skipped_already_published');
assert.equal(changedSelection.calls.length,0,'saved daily receipt skips before generator or media requests');
const pending=harness({state:{pendingSelectionKey:'previous-day-or-version'}});
const pendingBefore=structuredClone(pending.state);
assert.equal((await pending.run())[0].json.status,'blocked_reconciliation_required');
assert.equal(pending.calls.length,1);
assert.deepEqual(pending.state,pendingBefore,'unknown existing publication receipts are not edited');
const uncertain=harness({publishFailure:true});
assert.equal((await uncertain.run())[0].json.status,'blocked_reconciliation_required');
assert.equal(uncertain.calls.filter(c=>c.url.includes('/media_publish')).length,1);
assert.equal(uncertain.state.pendingSelectionKey,payload.selectionKey);
assert.ok(!uncertain.state.lastPostId);
assert.equal((await uncertain.run())[0].json.status,'blocked_reconciliation_required');
assert.equal(uncertain.calls.filter(c=>c.url.includes('/media_publish')).length,1);

const metaFailure=harness({graphFailure:{statusCode:400,headers:{'x-fb-trace-id':'trace-header-217'},
  body:{error:{message:'Only photo or video can be accepted as media type. test-token',
    code:9004,error_subcode:2207052,error_user_msg:'Could not fetch media test-cron Bearer opaque-private-token'}}}});
await assert.rejects(metaFailure.run(),error=>{
  assert.equal(error.httpStatus,400);assert.equal(error.metaCode,9004);assert.equal(error.metaSubcode,2207052);
  assert.match(error.message,/carousel_child_image_create/);
  assert.match(error.message,/HTTP 400, code 9004, subcode 2207052/);assert.match(error.message,/trace trace-header-217/);
  for(const secret of ['test-token','test-cron','opaque-private-token'])assert.ok(!error.message.includes(secret));
  assert.ok(error.message.length<=1000);return true;
});
assert.equal(metaFailure.calls.filter(call=>call.url.includes('/media_publish')).length,0,'failed child creation never publishes');
assert.deepEqual(metaFailure.state,{},'child failure never creates a publication receipt');
const parentFailure=harness({graphFailureStage:'parent',graphFailure:{statusCode:400,body:{error:{message:'Rejected parent',code:100,error_subcode:200}}}});
await assert.rejects(parentFailure.run(),error=>{assert.match(error.message,/carousel_parent_create/);assert.match(error.message,/HTTP 400, code 100, subcode 200/);return true;});
assert.equal(parentFailure.calls.filter(call=>call.url.includes('/media_publish')).length,0);
const diagnosedPublishFailure=harness({graphFailureStage:'publish',graphFailure:{statusCode:400,body:{error:{message:'Rejected publish',code:10,error_subcode:20}}}});
assert.equal((await diagnosedPublishFailure.run())[0].json.status,'blocked_reconciliation_required');
assert.match(diagnosedPublishFailure.state.pendingPublishError,/media_publish/);
assert.match(diagnosedPublishFailure.state.pendingPublishError,/HTTP 400, code 10, subcode 20/);
assert.equal(diagnosedPublishFailure.calls.filter(call=>call.url.includes('/media_publish')).length,1);
const boundedFailure=harness({graphFailure:{statusCode:400,
  body:{error:{message:'x'.repeat(5000),code:'9004',error_subcode:'2207052',fbtrace_id:'trace-body-217',error_user_msg:'y'.repeat(5000)}}}});
await assert.rejects(boundedFailure.run(),error=>{assert.ok(error.message.length<=1000);assert.match(error.message,/trace trace-body-217/);return true;});
const redactedAmbiguous=harness({publishFailure:true,publishErrorText:'Connection lost test-token test-cron Bearer opaque-publish-secret'});
assert.equal((await redactedAmbiguous.run())[0].json.status,'blocked_reconciliation_required');
assert.equal(redactedAmbiguous.calls.filter(call=>call.url.includes('/media_publish')).length,1,'ambiguous publication remains single-attempt');
for(const secret of ['test-token','test-cron','opaque-publish-secret'])assert.ok(!redactedAmbiguous.state.pendingPublishError.includes(secret));
assert.ok(redactedAmbiguous.state.pendingSelectionKey);

const stale=harness({imageStatus:409});
await assert.rejects(stale.run(),/image preflight failed/);
assert.ok(stale.calls.every(c=>c.method!=='POST' || c.url.endsWith('/api/social/daily-carousel')));
const preview=harness({dryRun:true,state:{pendingSelectionKey:'untouched'}});
const previewResult=(await preview.run())[0].json;
assert.equal(previewResult.status,'dry_run');
assert.equal(previewResult.locationName,'Belgrade, Serbia');
assert.equal(previewResult.locationId,'109920975697736');
assert.ok(preview.calls.every(c=>c.method!=='POST'));
assert.deepEqual(preview.state,{pendingSelectionKey:'untouched'});
const sparse=harness({data:{...payload,selectedCount:1,slides:[payload.slides[0],payload.slides.at(-1)]}});
assert.equal((await sparse.run())[0].json.status,'published');
const sparseCarousel=sparse.calls.find(c=>new URLSearchParams(c.body).get('media_type')==='CAROUSEL');
assert.equal(new URLSearchParams(sparseCarousel.body).get('caption'),payload.caption);
assert.equal(new URLSearchParams(sparseCarousel.body).get('children').split(',').length,2);
for(const slides of [payload.slides.slice(0,-1),[payload.slides.at(-1)],[payload.slides[0],payload.slides.at(-1),payload.slides.at(-1)],[payload.slides.at(-1),payload.slides[0]], [...payload.slides.slice(0,-1),{...payload.slides.at(-1),userTags:[{username:'unrelated'}]}]]) {
  const invalid=harness({data:{...payload,slides}});
  await assert.rejects(invalid.run(),/final closing card/);
  assert.ok(invalid.calls.every(c=>c.method!=='POST' || c.url.endsWith('/api/social/daily-carousel')));
}
const fallback=harness({tagFailure:true});
assert.deepEqual((await fallback.run())[0].json.fallbackMentionTags,['venue0','venue1','venue2']);
const noEvents=harness({data:{...payload,selectedCount:0,slides:[]}});
assert.equal((await noEvents.run())[0].json.status,'skipped_no_events');
assert.equal(noEvents.calls.length,1);

const customLocation=harness({envOverrides:{EVENTZEKA_IG_LOCATION_ID:'123456789012345'}});
assert.equal((await customLocation.run())[0].json.locationId,'123456789012345');
assert.equal(new URLSearchParams(customLocation.calls.find(c=>new URLSearchParams(c.body).get('media_type')==='CAROUSEL').body).get('location_id'),'123456789012345');
const invalidLocation=harness({envOverrides:{EVENTZEKA_IG_LOCATION_ID:'Belgrade, Serbia'}});
await assert.rejects(invalidLocation.run(),/numeric location Page ID/);
assert.equal(invalidLocation.calls.length,0);

const workflow=JSON.parse(readFileSync(new URL('../ops/n8n/event-zeka-daily-instagram-carousel.json',import.meta.url),'utf8'))[0];
assert.equal(workflow.nodes.find(n=>n.type==='n8n-nodes-base.scheduleTrigger').parameters.rule.interval[0].expression,'30 16 * * *');

assert.equal(workflow.settings.executionTimeout,900,'publication deadline stays below catch-up spacing');
assert.deepEqual(workflow.nodes.find(candidate=>candidate.type==='n8n-nodes-base.scheduleTrigger').parameters.rule.interval.map(item=>item.expression),['30 16 * * *', '0 17 * * *', '30 17 * * *']);
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

assert.equal(workflow.settings.timezone,'Europe/Belgrade');
assert.equal(workflow.active,false);
assert.equal(workflow.staticData,null);
assert.ok(workflow.nodes.find(n=>n.id==='generate-and-publish').parameters.jsCode.startsWith(publishEventZekaCarousel.toString()));
const native=harness();
const code=workflow.nodes.find(n=>n.id==='generate-and-publish').parameters.jsCode;
assert.ok(!code.includes(assertSocialPublicationResult.toString()),'publisher returns state before the separate assertion node runs');
assert.ok(code.includes('return await publishEventZekaCarousel('));
const nativeContext=vm.createContext({$env:{...env,EVENTZEKA_SOCIAL_PREVIEW_HISTORY:'true'},$execution:{mode:'manual'},
  Date:class extends Date { constructor(value='2026-10-13T14:30:00Z'){super(value);} },
  helpers:{httpRequest:async request=>{
    if(request.url.endsWith('/api/social/daily-carousel')) return {statusCode:200,body:payload};
    if(request.url.includes('/media?fields=caption,timestamp')) return {statusCode:200,body:{data:[]}};
    if(request.method==='HEAD') return {statusCode:200,headers:{'content-type':'image/jpeg'}};
    throw new Error('Manual execution cannot publish');
  }},$getWorkflowStaticData:()=>{throw new Error('Manual execution cannot access state');},URL:undefined,URLSearchParams:undefined});
assert.equal((await new vm.Script(`(async()=>{${code}})()`).runInContext(nativeContext))[0].json.status,'dry_run');
assert.deepEqual(native.state,{});
console.log('n8n agenda QA passed: one post/day, pending reconciliation, preflight, safe dry run, tags, carousel location, and sparse-day publishing.');
