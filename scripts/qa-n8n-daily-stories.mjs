import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { publishEventZekaStories, publishPreparedInstagramStory, hasPublishedInstagramStoryToday } from '../ops/n8n/publish-daily-stories.mjs';
import { assertSocialPublicationResult } from '../ops/n8n/social-publication-result.mjs';

const date = '2026-10-15';
const env = { EVENTZEKA_API_ORIGIN: 'https://eventzeka.com', EVENTZEKA_CRON_SECRET: 'test-secret', EVENTZEKA_IG_USER_ID: 'test-account', EVENTZEKA_IG_ACCESS_TOKEN: 'test-token' };
const makePayload = day => {
  const videoUrl = `https://eventzeka.com/api/social/stories/days/${day}?events=event1,event2,event3,event4&v=s5-test&publishDate=${day}`;
  return { publishDate: day, selectionKey: `${day}:stories:test`, selectedCount: 4, selectionPolicy: 'prefer_unposted', repeatedEventIds: [], durationSeconds:18, hasClosingCta:true, frames: [
    { kind:'agenda', date:day, eventIds:['event1','event2','event3','event4'], userTags:[{username:'space.one',x:.5,y:.4},{username:'space.two',x:.5,y:.7}],
      mediaType:'VIDEO', videoUrl, imageUrl:`${videoUrl}&cover=1`, durationSeconds:18, hasClosingCta:true },
  ] };
};
const now = () => new Date('2026-10-15T08:00:00Z');
function setup(options = {}) {
  const state = options.state || {};
  const calls = [];
  let created = 0;
  let published = 0;
  const httpRequest = async request => {
    calls.push(request);
    if (request.url.includes('/api/social/daily-stories')) return { statusCode: 200, body: options.payload || makePayload(date) };
    if (request.url.includes('/media?fields=caption,timestamp')) return { statusCode: 200, body: { data: [] } };
    if (request.method === 'HEAD') return { statusCode: options.badImage ? 409 : 200, headers: {
      'content-type':request.url.includes('cover=1')?'image/jpeg':'video/mp4', 'accept-ranges':options.noRanges?'none':'bytes' } };
    if (request.headers?.Range) return {statusCode:options.badRange?200:206,headers:{'content-type':'video/mp4','content-range':'bytes 0-31/65536'},body:new Uint8Array(32)};
    if (request.url.includes('/stories?fields=id,timestamp')) return {statusCode:200,body:options.activeStory?{data:[{id:'already-live',timestamp:'2026-10-15T07:55:00Z'}]}:{data:[]}};
    if (request.url.endsWith('/media')) {
      created += 1;
      if (options.failCreation) return { statusCode: 400, body: { error: { message: 'Rejected agenda container' } } };
      return { statusCode: 200, body: { id: `container${created}` } };
    }
    if (request.url.includes('?fields=status_code,status')) return { statusCode: 200, body: { status_code: 'FINISHED' } };
    if (request.url.endsWith('/media_publish')) {
      published += 1;
      if (options.failPublish === published) throw new Error(`Connection lost ${env.EVENTZEKA_IG_ACCESS_TOKEN}`);
      if (options.publishError && (options.rejectAlways || published === 1)) return {statusCode:options.publishError.status,body:{error:{message:'Not ready',code:options.publishError.code,error_subcode:options.publishError.subcode}}};
      return { statusCode: 200, body: options.missingPublishId ? {} : { id: `story${published}` } };
    }
    throw new Error('Unexpected request');
  };
  const waits=[];
  const run = overrides => publishEventZekaStories({ env: { ...env, ...overrides }, httpRequest, getStaticData: () => state, now: options.now || now, wait:async milliseconds=>{waits.push(milliseconds);} });
  return { state, calls, httpRequest, run, waits, get created() { return created; }, get published() { return published; } };
}
let test = setup();
let result = (await test.run())[0].json;
assert.equal(result.status, 'published');
assert.deepEqual(result.storyIds, ['story1']);
assert.equal(result.frameCount, 1);
assert.equal(result.durationSeconds,18);assert.equal(result.hasClosingCta,true);assert.equal(result.mediaType,'VIDEO');
assert.equal(test.state.lastPublishDate, date);
assert.equal(test.state.pending, undefined);
assert.equal(test.created, 1);
for (const call of test.calls.filter(call => call.url.endsWith('/media'))) {
  const body = new URLSearchParams(call.body);
  assert.equal(body.get('media_type'), 'STORIES');
  assert.equal(body.get('location_id'),'109920975697736');
  assert.deepEqual(JSON.parse(body.get('user_tags')),makePayload(date).frames[0].userTags);
  assert.equal(body.get('video_url'),makePayload(date).frames[0].videoUrl);
  assert.deepEqual([...body.keys()].sort(), ['location_id', 'media_type', 'user_tags', 'video_url']);
}
assert.ok(test.calls.filter(call=>call.method==='HEAD'||call.headers?.Range).every(call=>call.timeout>=360000),'uncached native video rendering has at least six minutes');
assert.equal(test.calls.filter(call=>call.headers?.Range==='bytes=0-31').length,1,'verify a real byte-range response before creating a Story');
const firstPublish = test.calls.findIndex(call => call.url.endsWith('/media_publish'));
assert.equal(test.calls.slice(0, firstPublish).filter(call => call.url.endsWith('/media')).length, 1);
assert.equal((await test.run())[0].json.status, 'skipped_already_published');
assert.equal(test.published, 1);

test = setup();
result = (await test.run({ EVENTZEKA_SOCIAL_DRY_RUN: 'true', EVENTZEKA_IG_ACCESS_TOKEN: '' }))[0].json;
assert.equal(result.status, 'dry_run');
assert.equal(test.calls.filter(call => call.method === 'HEAD').length, 2);
assert.deepEqual(test.state, {});
assert.equal(test.created, 0);

for(const tags of [[{username:'space.one',x:1.1,y:.5}],[{username:'bad handle',x:.4,y:.5}],[{username:'space.one',x:.4,y:.5},{username:'space.one',x:.5,y:.6}]]){
 const bad=makePayload(date);bad.frames[0].userTags=tags;test=setup({payload:bad});
 await assert.rejects(test.run(),/Invalid Story venue tags/);assert.equal(test.created,0);
}
test=setup();await assert.rejects(test.run({EVENTZEKA_STORY_LOCATION_ID:'not-a-location'}),/numeric location Page/);assert.equal(test.created,0);
const legacyNoTags=makePayload(date);delete legacyNoTags.frames[0].userTags;
test=setup({payload:legacyNoTags});assert.equal((await test.run())[0].json.status,'published');
assert.equal(new URLSearchParams(test.calls.find(call=>call.url.endsWith('/media')).body).has('user_tags'),false,'legacy frozen plans remain recoverable');

test = setup({ payload: { publishDate: date, selectedCount: 0, frames: [] } });
assert.equal((await test.run())[0].json.status, 'skipped_no_events');
test = setup({ payload: makePayload('2026-10-16') });
await assert.rejects(test.run(), /different Belgrade date/);
assert.equal(test.created, 0);
test = setup({ badImage: true });
await assert.rejects(test.run(), /preflight/);
assert.equal(test.created, 0);
test = setup({ failCreation: true });
await assert.rejects(test.run(), /Rejected agenda container/);
assert.equal(test.published, 0);
assert.deepEqual(test.state, {});

const legacyPayload = makePayload(date);
legacyPayload.frames.push({ kind: 'cta', date, eventIds: [], imageUrl: 'https://eventzeka.com/api/social/stories/cta?v=s1-test' });
test = setup({ payload: legacyPayload });
await assert.rejects(test.run(), /exactly one current-day DANAS video/);
assert.equal(test.created, 0, 'a legacy closing card is never published');
test = setup({ state: { series: legacyPayload } });
await assert.rejects(test.run(), /exactly one current-day DANAS video/);
assert.equal(test.created, 0, 'a saved legacy sequence is never resumed with a closing card');

test = setup({ failPublish: 1 });
result = (await test.run())[0].json;
assert.equal(result.status, 'blocked_reconciliation_required');
assert.equal(test.published, 1, 'the failed publish is attempted once');
assert.equal(test.state.series.frames[0].postId, undefined);
assert.equal(test.state.pending.frameIndex, 0);
assert.ok(!JSON.stringify(test.state).includes('test-token'));
const pendingState = structuredClone(test.state);
const nextDay = setup({ state: pendingState, now: () => new Date('2026-10-16T08:00:00Z'), payload: makePayload('2026-10-16') });
assert.equal((await nextDay.run())[0].json.status, 'blocked_reconciliation_required');
assert.equal(nextDay.calls.length, 0, 'unresolved outcomes block all dates');
// Simulate an operator confirming that the agenda publish did not happen.
delete pendingState.pending;
test = setup({ state: pendingState });
result = (await test.run())[0].json;
assert.equal(result.status, 'published');
assert.equal(test.created, 0);
assert.equal(test.published, 1);
assert.equal(test.calls.filter(call => call.method === 'HEAD').length, 2);
assert.equal(test.calls.filter(call => call.url.includes('/api/social/daily-stories')).length, 0, 'same-day recovery keeps its saved selection');
assert.equal(result.storyIds[0], 'story1');

const confirmed = makePayload(date);
confirmed.frames[0].postId = 'confirmed-agenda';
test = setup({ state: { series: confirmed } });
result = (await test.run())[0].json;
assert.deepEqual(result.storyIds, ['confirmed-agenda']);
assert.equal(test.published, 0, 'a confirmed agenda only completes its receipt');
assert.equal(test.calls.length, 1,'complete saved receipts still verify the live active-Story guard');

test = setup({ missingPublishId: true });
assert.equal((await test.run())[0].json.status, 'blocked_reconciliation_required');
assert.equal(test.published, 1);
assert.ok(test.state.pending);
const previous = makePayload('2026-10-14'); previous.frames[0].postId = 'previous-day-story';
test = setup({ state: { series: previous } });
assert.equal((await test.run())[0].json.status, 'published');
assert.equal(test.published, 1);
assert.equal(test.state.lastIncompleteSeries.publishDate, '2026-10-14');
assert.deepEqual(test.state.lastIncompleteSeries.storyIds, ['previous-day-story']);

for (const mutate of [
  data=>{data.hasClosingCta=false;}, data=>{data.durationSeconds=15;},
  data=>{data.frames[0].hasClosingCta=false;}, data=>{data.frames[0].durationSeconds=15;},
  data=>{data.frames[0].mediaType='IMAGE';}, data=>{data.frames[0].videoUrl=data.frames[0].videoUrl.replace('s5-','s4-');},
  data=>{data.frames[0].videoUrl=data.frames[0].videoUrl.replace(`publishDate=${date}`,'publishDate=2026-10-16');},
  data=>{data.frames[0].videoUrl+='&publishDate=2026-10-16';},
  data=>{data.frames[0].imageUrl=data.frames[0].imageUrl.replace('cover=1','cover=0');},
  data=>{data.frames[0].videoUrl=data.frames[0].videoUrl.replace('https://eventzeka.com','https://untrusted.example');},
]) {
  const invalid=makePayload(date);mutate(invalid);const saved={unrelated:{receipt:'retain-me'}};
  test=setup({payload:invalid,state:saved});const before=structuredClone(saved);
  await assert.rejects(test.run(),/18-second closing CTA/);
  assert.equal(test.created,0);assert.equal(test.published,0);assert.deepEqual(saved,before);
}
for (const options of [{badRange:true},{noRanges:true}]) {
  test=setup(options);await assert.rejects(test.run(),/preflight/);assert.equal(test.created,0);assert.deepEqual(test.state,{});
}
test=setup({activeStory:true,state:{unrelated:{receipt:'untouched'}}});
const beforeDuplicate=structuredClone(test.state);
assert.equal((await test.run())[0].json.status,'blocked_reconciliation_required');
assert.equal(test.created,0);assert.equal(test.published,0);assert.deepEqual(test.state,beforeDuplicate,'live duplicate guard preserves every saved key');

for (const rejection of [{status:400,code:24,subcode:2207008},{status:400,code:9007,subcode:2207027}]) {
  test=setup({publishError:rejection});assert.equal((await test.run())[0].json.status,'published');
  assert.equal(test.published,2);assert.deepEqual(test.waits,[30000],'only the explicit safe rejection permits a delayed retry');
  const attempts=test.calls.filter(call=>call.url.endsWith('/media_publish'));
  assert.ok(attempts.every(call=>new URLSearchParams(call.body).get('creation_id')==='container1'),'safe retries reuse the exact container');
  const finishedReads=test.calls.filter(call=>call.url.includes('container1?fields=status_code,status'));
  assert.equal(finishedReads.length,3,'check FINISHED before both publish attempts, in addition to preparation');
  test=setup({publishError:rejection,rejectAlways:true,state:{unrelated:{receipt:'retain-me'}}});
  assert.equal((await test.run())[0].json.status,'blocked_reconciliation_required');
  assert.equal(test.published,3);assert.deepEqual(test.waits,[30000,60000]);
  assert.equal(test.state.pending.definitivelyRejected,true);
  assert.match(test.state.pending.error,new RegExp(`HTTP 400, code ${rejection.code}, subcode ${rejection.subcode}`),'retain live Meta failure metadata');
  const frozen=structuredClone(test.state);
  const resume=setup({state:frozen,payload:{...makePayload(date),selectionKey:'different-incoming-selection'}});
  assert.equal((await resume.run())[0].json.status,'published');
  assert.equal(resume.created,0);assert.equal(resume.calls.filter(call=>call.url.includes('/api/social/daily-stories')).length,0);
  assert.equal(resume.state.lastSelectionKey,`${date}:stories:test`,'known rejection resumes the exact frozen video');
  assert.deepEqual(resume.state.unrelated,{receipt:'retain-me'});
}
for (const rejection of [{status:500,code:24,subcode:2207008},{status:400,code:24,subcode:123},{status:429,code:9007,subcode:2207027}]) {
  test=setup({publishError:rejection});assert.equal((await test.run())[0].json.status,'blocked_reconciliation_required');
  assert.equal(test.published,1,'ambiguous and unrecognized errors never retry media_publish');
  assert.deepEqual(test.waits,[]);assert.equal(test.state.pending.definitivelyRejected,false);
  const saved=structuredClone(test.state);const blocked=setup({state:saved});const before=structuredClone(saved);
  assert.equal((await blocked.run())[0].json.status,'blocked_reconciliation_required');assert.equal(blocked.calls.length,0);assert.deepEqual(saved,before);
}
for (const mismatch of ['selectionKey','containerId','publishDate','frameIndex']) {
  const frozen=makePayload(date);frozen.frames[0].containerId='saved-container';
  const pending={publishDate:date,selectionKey:frozen.selectionKey,containerId:'saved-container',frameIndex:0,definitivelyRejected:true};
  pending[mismatch]=mismatch==='frameIndex'?1:'different';
  const saved={series:frozen,pending,unrelated:{keep:true}};const before=structuredClone(saved);
  test=setup({state:saved});assert.equal((await test.run())[0].json.status,'blocked_reconciliation_required');
  assert.equal(test.calls.length,0);assert.deepEqual(saved,before,'a mismatched retry receipt is never edited or cleared');
}
let directPublishCalls=0;
await assert.rejects(publishPreparedInstagramStory({userId:'account',containerId:'saved',wait:async()=>{},graphRequest:async()=>{
  directPublishCalls++;return {status_code:'IN_PROGRESS'};
}}),/container is IN_PROGRESS/);
assert.equal(directPublishCalls,1,'an unfinished container never reaches media_publish');
const marker=new Error('ambiguous transport');let directWaits=0;
await assert.rejects(publishPreparedInstagramStory({userId:'account',containerId:'saved',wait:async()=>{directWaits++;},graphRequest:async path=>{
  if(path.includes('?fields='))return {status_code:'FINISHED'};throw marker;
}}),error=>error===marker);
assert.equal(directWaits,0,'ambiguous transport never enters the definitive-rejection backoff');
let pages=0;
assert.equal(await hasPublishedInstagramStoryToday({userId:'account',today:date,graphRequest:async path=>{
  pages++;if(pages===1)return {data:[{id:'yesterday',timestamp:'2026-10-14T08:00:00Z'}],paging:{next:'next-page',cursors:{after:'cursor-two'}}};
  assert.ok(path.endsWith('&after=cursor-two'));return {data:[{id:'today',timestamp:'2026-10-14T22:30:00Z'}]};
}}),true,'active-Story paging uses the Belgrade date, including after midnight');
assert.equal(pages,2);
await assert.rejects(hasPublishedInstagramStoryToday({userId:'account',today:date,graphRequest:async()=>({data:[],paging:{next:'next-page'}})}),/completely verify/);
await assert.rejects(hasPublishedInstagramStoryToday({userId:'account',today:date,graphRequest:async()=>({data:[{id:'invalid',timestamp:'unknown'}]})}),/Invalid active/);

const [workflow] = JSON.parse(readFileSync(new URL('../ops/n8n/event-zeka-daily-stories.json', import.meta.url)));
assert.equal(workflow.active, false);
assert.equal(workflow.staticData, null);
assert.equal(workflow.settings.timezone, 'Europe/Belgrade');
assert.equal(workflow.nodes.find(node => node.type === 'n8n-nodes-base.scheduleTrigger').parameters.rule.interval[0].expression, '0 10 * * *');

assert.equal(workflow.settings.executionTimeout,900,'publication deadline stays below catch-up spacing');
assert.deepEqual(workflow.nodes.find(candidate=>candidate.type==='n8n-nodes-base.scheduleTrigger').parameters.rule.interval.map(item=>item.expression),['0 10 * * *', '30 10 * * *', '0 11 * * *']);
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

const node = workflow.nodes.find(node => node.type === 'n8n-nodes-base.code');
assert.ok(node.parameters.jsCode.startsWith(publishEventZekaStories.toString()));
for(const helper of [publishPreparedInstagramStory,hasPublishedInstagramStoryToday])assert.ok(node.parameters.jsCode.includes(helper.toString()),'generated workflow retains every live recovery helper');
assert.ok(!node.parameters.jsCode.includes(assertSocialPublicationResult.toString()),'publisher returns state before result verification');
assert.ok(node.parameters.jsCode.includes('return await publishEventZekaStories('));
assert.throws(()=>assertSocialPublicationResult([{json:{status:'blocked_reconciliation_required',reason:'operator check'}}]),/Social publication failed/);
test = setup();
const context = vm.createContext({ $env: { ...env, EVENTZEKA_SOCIAL_DRY_RUN: 'true' }, helpers: { httpRequest: test.httpRequest },
  Date: class extends Date { constructor(value='2026-10-15T08:00:00Z'){super(value);} },
  $execution: { mode: 'trigger' }, $getWorkflowStaticData: () => { throw new Error('Dry runs cannot access publication state'); }, URLSearchParams: undefined, URL: undefined });
const nativeResult = await new vm.Script(`(async () => {${node.parameters.jsCode}})()`).runInContext(context);
assert.equal(nativeResult[0].json.status, 'dry_run');
assert.equal(test.created, 0);
test = setup();
const manualContext = vm.createContext({ $env: env, $execution: { mode: 'manual' }, helpers: { httpRequest: test.httpRequest },
  Date: class extends Date { constructor(value='2026-10-15T08:00:00Z'){super(value);} },
  $getWorkflowStaticData: () => { throw new Error('Manual previews cannot access publication state'); } });
const manualResult = await new vm.Script(`(async () => {${node.parameters.jsCode}})()`).runInContext(manualContext);
assert.equal(manualResult[0].json.status, 'dry_run', 'manual execution previews even with valid production credentials');
assert.equal(test.created, 0);
console.log('n8n Story QA passed: 18-second video_url and mandatory CTA, byte ranges, native sandbox, 10:00 schedule, venue/location metadata, paged duplicate guard, exact recovery receipts, definitive-rejection-only retries and ambiguous-publish blocking.');
