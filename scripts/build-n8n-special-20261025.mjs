import {readFileSync,writeFileSync} from 'node:fs';
import {publishEventZekaSpecial} from '../ops/n8n/publish-special-20261025.mjs';

const plan=JSON.parse(readFileSync(new URL('../public/social/special/2026-10-25/manifest.json',import.meta.url),'utf8'));
const names={post:'Publish Special Photo',story:'Publish Special Story',reel:'Publish Special Reel'};
const code=format=>`${publishEventZekaSpecial.toString()}\n\nreturn await publishEventZekaSpecial({env:$env,httpRequest:this.helpers.httpRequest.bind(this.helpers),getStaticData:()=>$getWorkflowStaticData('global'),plan:${JSON.stringify(plan)},format:'${format}',forceDryRun:$execution.mode==='manual'});`;
const check=name=>({id:'continue-'+name,name:'Continue after '+name,type:'n8n-nodes-base.if',typeVersion:2.2,position:[name==='post'?20:480,80],parameters:{conditions:{options:{caseSensitive:true,leftValue:'',typeValidation:'strict',version:2},conditions:[{id:'continue',leftValue:'={{ $json.continue }}',rightValue:true,operator:{type:'boolean',operation:'true',singleValue:true}}],combinator:'and'},options:{}}});
const workflow={id:'EzekaSpecial20261025',name:'Event Zeka - 25 October 2026 at 10:00',description:'One-off 2026-10-25 10:00 Europe/Belgrade: the user-supplied image as photo, Story and Reels-only video with the exact caption Iza\u0111i i glasaj! Regular publishers skip this local date. Exact year guard, separate per-format receipts, stop on unknown publication outcomes. Manual execution only previews. Regular schedules resume 26 October.',active:false,
  nodes:[{id:'manual-special-preview',name:'Manual Special Preview',type:'n8n-nodes-base.manualTrigger',typeVersion:1,position:[-460,-90],parameters:{}},
    {id:'special-schedule',name:'25 October at 10:00 Belgrade',type:'n8n-nodes-base.scheduleTrigger',typeVersion:1.2,position:[-460,170],parameters:{rule:{interval:[{field:'cronExpression',expression:'0 10 25 10 *'}]}}},
    ...['post','story','reel'].map((format,index)=>({id:'special-'+format,name:names[format],type:'n8n-nodes-base.code',typeVersion:2,position:[-180+index*460,80],parameters:{jsCode:code(format)}})),check('post'),check('story')],
  connections:{'Manual Special Preview':{main:[[{node:names.post,type:'main',index:0}]]},'25 October at 10:00 Belgrade':{main:[[{node:names.post,type:'main',index:0}]]},
    [names.post]:{main:[[{node:'Continue after post',type:'main',index:0}]]},'Continue after post':{main:[[{node:names.story,type:'main',index:0}],[]]},
    [names.story]:{main:[[{node:'Continue after story',type:'main',index:0}]]},'Continue after story':{main:[[{node:names.reel,type:'main',index:0}],[]]}},
  settings:{executionOrder:'v1',timezone:'Europe/Belgrade',saveDataSuccessExecution:'all',saveDataErrorExecution:'all',saveExecutionProgress:true},staticData:null,versionId:'395c7a8c-0240-4d72-91df-c879f27b3bf3',versionCounter:1,tags:[]};
writeFileSync(new URL('../ops/n8n/event-zeka-special-20261025.json',import.meta.url),JSON.stringify([workflow],null,2)+'\n');
console.log('Built inactive one-off 25 October photo, Story and Reel workflow.');
