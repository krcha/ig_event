import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { publishEventZekaCarousel } from '../ops/n8n/publish-daily-carousel.mjs';

const env = { EVENTZEKA_API_ORIGIN: 'https://api.example.test', EVENTZEKA_CRON_SECRET: 'test-cron',
  EVENTZEKA_IG_USER_ID: 'test-account', EVENTZEKA_IG_ACCESS_TOKEN: 'test-token' };
const payload = { publishDate:'2026-10-13', eventDates:['2026-10-14','2026-10-15','2026-10-16'],
  selectionKey:'agenda-v1', selectedCount:9, caption:'Program za naredna tri dana.',
  slides:[0,1,2].map(i => ({kind:'agenda',eventIds:[`event-${i}`],imageUrl:`https://api.example.test/agenda-${i}.jpg`,
    userTags:[{username:`venue${i}`,x:.5,y:.5}]})) };
function harness({state={},data=payload,imageStatus=200,publishFailure=false,tagFailure=false,dryRun=false}={}) {
  const calls=[];
  let count=0;
  const httpRequest=async options => {
    calls.push(options);
    if (options.url.endsWith('/api/social/daily-carousel')) return {statusCode:200,body:data};
    if (options.method==='HEAD') return {statusCode:imageStatus,headers:{'content-type':'image/jpeg'}};
    if (options.url.includes('/media_publish')) {
      if (publishFailure) throw new Error('Ambiguous transport failure');
      return {statusCode:200,body:{id:'published-test'}};
    }
    if (options.url.includes('?fields=status_code,status')) return {statusCode:200,body:{status_code:'FINISHED'}};
    const body=new URLSearchParams(options.body);
    if (tagFailure && body.has('user_tags')) return {statusCode:400,body:{error:{message:'Tag rejected'}}};
    return {statusCode:200,body:{id:`container-${++count}`}};
  };
  return {state,calls,run:()=>publishEventZekaCarousel({env:{...env,...(dryRun?{EVENTZEKA_SOCIAL_DRY_RUN:'true'}:{})},
    httpRequest,getStaticData:()=>state})};
}
const success=harness();
assert.equal((await success.run())[0].json.status,'published');
assert.equal(success.state.lastPublishDate,payload.publishDate);
assert.equal(success.calls.filter(c=>c.url.includes('/media_publish')).length,1);
assert.equal(success.calls.filter(c=>new URLSearchParams(c.body).has('user_tags')).length,3);
assert.equal(success.calls.filter(c=>c.method==='HEAD').length,3);
assert.ok(!success.state.pendingSelectionKey);

const changedSelection=harness({state:{lastPublishDate:payload.publishDate,lastSelectionKey:'old-version'}});
assert.equal((await changedSelection.run())[0].json.status,'skipped_already_published');
assert.equal(changedSelection.calls.length,1);
const pending=harness({state:{pendingSelectionKey:'previous-day-or-version'}});
assert.equal((await pending.run())[0].json.status,'blocked_reconciliation_required');
assert.equal(pending.calls.length,1);
const uncertain=harness({publishFailure:true});
assert.equal((await uncertain.run())[0].json.status,'blocked_reconciliation_required');
assert.equal(uncertain.calls.filter(c=>c.url.includes('/media_publish')).length,1);
assert.equal(uncertain.state.pendingSelectionKey,payload.selectionKey);
assert.ok(!uncertain.state.lastPostId);
assert.equal((await uncertain.run())[0].json.status,'blocked_reconciliation_required');
assert.equal(uncertain.calls.filter(c=>c.url.includes('/media_publish')).length,1);

const stale=harness({imageStatus:409});
await assert.rejects(stale.run(),/image preflight failed/);
assert.ok(stale.calls.every(c=>c.method!=='POST'));
const preview=harness({dryRun:true,state:{pendingSelectionKey:'untouched'}});
assert.equal((await preview.run())[0].json.status,'dry_run');
assert.ok(preview.calls.every(c=>c.method!=='POST'));
assert.deepEqual(preview.state,{pendingSelectionKey:'untouched'});
const sparse=harness({data:{...payload,selectedCount:1,slides:payload.slides.slice(0,1)}});
assert.equal((await sparse.run())[0].json.status,'published');
const singleCreate=sparse.calls.find(c=>c.method==='POST'&&!c.url.includes('/media_publish'));
assert.equal(new URLSearchParams(singleCreate.body).get('caption'),payload.caption);
assert.ok(!new URLSearchParams(singleCreate.body).has('is_carousel_item'));
assert.ok(!sparse.calls.some(c=>new URLSearchParams(c.body).get('media_type')==='CAROUSEL'));
const fallback=harness({tagFailure:true});
assert.deepEqual((await fallback.run())[0].json.fallbackMentionTags,['venue0','venue1','venue2']);
const noEvents=harness({data:{...payload,selectedCount:0,slides:[]}});
assert.equal((await noEvents.run())[0].json.status,'skipped_no_events');
assert.equal(noEvents.calls.length,1);

const workflow=JSON.parse(readFileSync(new URL('../ops/n8n/event-zeka-daily-instagram-carousel.json',import.meta.url),'utf8'))[0];
assert.equal(workflow.nodes.find(n=>n.type==='n8n-nodes-base.scheduleTrigger').parameters.rule.interval[0].expression,'30 16 * * *');
assert.equal(workflow.settings.timezone,'Europe/Belgrade');
assert.equal(workflow.active,false);
assert.equal(workflow.staticData,null);
assert.ok(workflow.nodes.find(n=>n.id==='generate-and-publish').parameters.jsCode.startsWith(publishEventZekaCarousel.toString()));
console.log('n8n agenda QA passed: one post/day, pending reconciliation, preflight, safe dry run, tags, and sparse-day publishing.');
