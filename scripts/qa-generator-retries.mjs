import test from 'node:test';
import assert from 'node:assert/strict';
import { publishEventZekaStories, publishPreparedInstagramStory, hasPublishedInstagramStoryToday } from '../ops/n8n/publish-daily-stories.mjs';
import { publishEventZekaReel } from '../ops/n8n/publish-daily-reels.mjs';
import { publishEventZekaCarousel } from '../ops/n8n/publish-daily-carousel.mjs';
import { fetchEventZekaPublicationContext, rememberEventZekaSelection } from '../ops/n8n/social-publication-history.mjs';
const fixedNow = () => new Date('2026-10-20T08:00:00Z');
const baseEnv = { EVENTZEKA_API_ORIGIN:'https://generator.invalid', EVENTZEKA_CRON_SECRET:'private-cron-marker',
  EVENTZEKA_IG_ACCESS_TOKEN:'private-instagram-marker', EVENTZEKA_REELS_FB_ACCESS_TOKEN:'private-facebook-marker' };
const publishers = [
  ['story', publishEventZekaStories, {publishDate:'2026-10-20',selectedCount:0,frames:[]}],
  ['reel', publishEventZekaReel, {publishDate:'2026-10-20',eventDate:'2026-10-21',selectedCount:0,eventIds:[],sourceEventCount:0}],
  ['carousel', publishEventZekaCarousel, {publishDate:'2026-10-20',selectedCount:0,slides:[]}],
];
async function withFakeWait(run) {
  const original=globalThis.setTimeout, delays=[];
  globalThis.setTimeout=(resolve,ms)=>{delays.push(ms);queueMicrotask(resolve);return 1;};
  try { return await run(delays); } finally { globalThis.setTimeout=original; }
}
function generatorUrl(options) { return options.url.startsWith('https://generator.invalid/api/social/daily-'); }
for (const [name,publish,empty] of publishers) {
  test(name+': transient503 is retried, successful no-event selection is preserved', async()=>{
    await withFakeWait(async delays=>{
      const requests=[];
      const result=await publish({env:baseEnv,now:fixedNow,forceDryRun:true,
        getStaticData(){throw new Error('Dry run touched static state.');},
        httpRequest:async options=>{assert.ok(generatorUrl(options));requests.push(options);
          return requests.length===1?{statusCode:503,body:{error:'Temporary generator outage'}}:{statusCode:200,body:empty};}});
      assert.equal(result[0].json.status,'skipped_no_events');
      assert.equal(requests.length,2); assert.deepEqual(delays,[5000]);
      assert.ok(requests.every(options=>options.timeout===45000));
      assert.ok(requests.every(options=>options.method==='GET'));
    });
  });
  test(name+': transport timeout is retried only on the generator request', async()=>{
    await withFakeWait(async delays=>{
      let count=0;
      const result=await publish({env:baseEnv,now:fixedNow,forceDryRun:true,
        getStaticData(){throw new Error('Dry run touched static state.');},
        httpRequest:async options=>{assert.ok(generatorUrl(options));if(++count===1)throw new Error('ETIMEDOUT');return{statusCode:200,body:empty};}});
      assert.equal(result[0].json.status,'skipped_no_events');assert.equal(count,2);assert.deepEqual(delays,[5000]);
    });
  });
  test(name+': nonretryable401 fails immediately and redacts all known credentials', async()=>{
    await withFakeWait(async delays=>{
      let count=0;
      await assert.rejects(publish({env:baseEnv,now:fixedNow,forceDryRun:true,getStaticData(){throw new Error('dry-state');},
        httpRequest:async options=>{assert.ok(generatorUrl(options));count++;return{statusCode:401,body:{error:'Denied '+Object.values(baseEnv).slice(1).join(' ')+' Bearer unrelated-token'}};}}),
        error=>{assert.match(error.message,/HTTP 401/);assert.match(error.message,/Denied/);
          for(const secret of Object.values(baseEnv).slice(1))assert.ok(!error.message.includes(secret));
          assert.ok(!error.message.includes('unrelated-token'));return true;});
      assert.equal(count,1);assert.deepEqual(delays,[]);
    });
  });
  test(name+':503 retries exhaust at four requests with safe upstream error detail', async()=>{
    await withFakeWait(async delays=>{
      let count=0;
      await assert.rejects(publish({env:baseEnv,now:fixedNow,forceDryRun:true,getStaticData(){throw new Error('dry-state');},
        httpRequest:async options=>{assert.ok(generatorUrl(options));count++;return{statusCode:503,body:JSON.stringify({error:{message:'Convex query unavailable '+baseEnv.EVENTZEKA_CRON_SECRET}})};}}),
        error=>{assert.match(error.message,/after 4 attempt/);assert.match(error.message,/HTTP 503/);assert.match(error.message,/Convex query unavailable/);assert.ok(!error.message.includes(baseEnv.EVENTZEKA_CRON_SECRET));return true;});
      assert.equal(count,4);assert.deepEqual(delays,[5000,15000,30000]);
    });
  });
  test(name+':429 respects Retry-After and caps excessively long waits', async()=>{
    await withFakeWait(async delays=>{
      let count=0;
      await publish({env:baseEnv,now:fixedNow,forceDryRun:true,getStaticData(){throw new Error('dry-state');},
        httpRequest:async options=>{assert.ok(generatorUrl(options));count++;
          return count===1?{statusCode:429,headers:{'Retry-After':'12'},body:'rate limited'}:
            count===2?{statusCode:429,headers:{'retry-after':'99999'},body:'rate limited'}:{statusCode:200,body:empty};}});
      assert.equal(count,3);assert.deepEqual(delays,[12000,30000]);
    });
  });
  test(name+': maximum Retry-After budget remains three30second waits',async()=>{
    await withFakeWait(async delays=>{
      let count=0;
      await assert.rejects(publish({env:baseEnv,now:fixedNow,forceDryRun:true,getStaticData(){throw new Error('dry-state');},
        httpRequest:async options=>{assert.ok(generatorUrl(options));count++;return{statusCode:429,headers:{'retry-after':'999999'},body:'limited'};}}),/after 4 attempt/);
      assert.equal(count,4);assert.deepEqual(delays,[30000,30000,30000]);
      assert.equal(count*45000+delays.reduce((sum,ms)=>sum+ms,0),270000);
    });
  });
  test(name+': HTTP-date Retry-After is bounded at30seconds', async()=>{
    await withFakeWait(async delays=>{
      let count=0;
      await publish({env:baseEnv,now:fixedNow,forceDryRun:true,getStaticData(){throw new Error('dry-state');},
        httpRequest:async options=>{assert.ok(generatorUrl(options));return++count===1?
          {statusCode:429,headers:{'retry-after':new Date(Date.now()+120000).toUTCString()},body:'limited'}:{statusCode:200,body:empty};}});
      assert.deepEqual(delays,[30000]);
    });
  });
  test(name+': read-only selectionPOST is retried without any Meta write',async()=>{
    await withFakeWait(async delays=>{
      let posts=0,gets=0,history=0;
      const state={};
      const env={...baseEnv,EVENTZEKA_IG_USER_ID:'123456789',EVENTZEKA_REELS_IG_USER_ID:'123456789'};
      const result=await publish({env,now:fixedNow,getStaticData:()=>state,
        httpRequest:async options=>{
          if(generatorUrl(options)) {
            if(options.method==='POST')return ++posts===1?{statusCode:502,body:{error:'Selection temporarily unavailable'}}:{statusCode:200,body:empty};
            gets++;return{statusCode:200,body:{publishDate:'2026-10-20',selectedCount:1,slides:[{}]}};
          }
          assert.equal(options.method,'GET','A Meta write escaped retry test.');
          assert.match(options.url,/\/media\?/);history++;return{statusCode:200,body:{data:[]}};
        }});
      assert.equal(result[0].json.status,'skipped_no_events');assert.equal(posts,2);assert.equal(history,1);
      assert.equal(gets,name==='carousel'?1:0);assert.deepEqual(delays,[5000]);assert.deepEqual(state,{});
    });
  });
  test(name+': serializedn8n publisher is self-contained with existing bundled helpers',async()=>{
    await withFakeWait(async delays=>{
      const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
      const bundle=[publish,fetchEventZekaPublicationContext,rememberEventZekaSelection,
        publishPreparedInstagramStory,hasPublishedInstagramStoryToday].map(fn=>fn.toString()).join('\n\n');
      const invoke=new AsyncFunction('options',bundle+'\nreturn '+publish.name+'(options);');
      let count=0;
      const result=await invoke({env:baseEnv,now:fixedNow,forceDryRun:true,getStaticData(){throw new Error('dry-state');},
        httpRequest:async options=>{assert.ok(generatorUrl(options));return++count===1?{statusCode:503,body:'temporarily unavailable'}:{statusCode:200,body:empty};}});
      assert.equal(result[0].json.status,'skipped_no_events');assert.deepEqual(delays,[5000]);
    });
  });
}
test('prepared Story publish remains single-attempt for an ambiguous transport failure', async()=>{
  const calls=[],failure=new Error('Transport result unknown');
  await assert.rejects(publishPreparedInstagramStory({userId:'123456789',containerId:'987654321',
    graphRequest:async(path,options)=>{calls.push([path,options]);if(path.includes('status_code'))return{status_code:'FINISHED'};assert.equal(options.singleAttempt,true);throw failure;},
    wait:async()=>{throw new Error('Ambiguous publish was retried.');}}),error=>error===failure);
  assert.equal(calls.length,2);
});
test('pending ambiguous receipt is still blocked before any Story/Reel network request',async()=>{
  for(const publish of [publishEventZekaStories,publishEventZekaReel]){
    const state={pending:{publishDate:'2026-10-20',containerId:'987654321',error:'unknown'}};
    const result=await publish({env:baseEnv,now:fixedNow,getStaticData:()=>state,httpRequest:async()=>{throw new Error('Blocked publication touched network.');}});
    assert.equal(result[0].json.status,'blocked_reconciliation_required');assert.ok(state.pending);
  }
});
