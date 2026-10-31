import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createCanvas} from '@napi-rs/canvas';
import {POSTER_FAMILIES,POSTER_CYCLE_LENGTH,SOCIAL_DESIGN_VERSION,getPosterDirection,getPosterDesignReceipt,resolvePosterPublicationDate} from '../lib/social/poster-directions.ts';
import {buildPosterArtwork,buildPosterClosing} from '../lib/social/poster-renderer.ts';
import {prepareDailyAgendaScene,publicationDateFor} from '../lib/social/material-scene.ts';
import {MATERIAL_ARCHETYPES,getMaterialArchetype,getMaterialState} from '../lib/social/material-background.mjs';
import {DURATION,FPS,READING_START,READING_END,getMotionState,drawFrame} from '../lib/social/material-motion.mjs';
import {getNextIsoDate} from '../lib/social/daily-carousel.ts';

const started=performance.now(),sha=value=>createHash('sha256').update(value).digest('hex');
const output=path.resolve('out/material-motion-production');await mkdir(output,{recursive:true});
assert.equal(SOCIAL_DESIGN_VERSION,'27-material-motion-20261020-v4');
assert.equal(POSTER_FAMILIES.length,27);assert.equal(POSTER_CYCLE_LENGTH,81);
assert.deepEqual(Object.keys(MATERIAL_ARCHETYPES).sort(),POSTER_FAMILIES.map(f=>f.id).sort(),'all 27 production families require an explicit material choreography');
assert.deepEqual([...new Set(Object.values(MATERIAL_ARCHETYPES))].sort(),[0,1,2,3,4,5]);
assert.deepEqual([DURATION,FPS,READING_START,READING_END],[18,30,2,13.2]);
const expectedCta=['event zeka','04 / 04','Zeka','zna.','Jo\u0161 doga\u0111aja na','eventzeka.com','Za slede\u0107i izlazak.'];
const safe=b=>b.x>=47.99&&b.x+b.width<=938.01&&b.y>=225.99&&b.y+b.height<=1560.01;
const facts=date=>[
 {_id:'materialevent01',date,title:'Razgovor o muzici i na\u0161em gradu',venue:'Kulturni centar Beograda',time:'18:00-20:00'},
 {_id:'materialevent02',date,title:'\u0427\u0438\u0442\u0430\u043b\u0430\u0447\u043a\u0430 \u0440\u0430\u0434\u0438\u043e\u043d\u0438\u0446\u0430 \u0437\u0430 \u0434\u0435\u0446\u0443',venue:'Etnografski muzej',time:'20:30'},
 {_id:'materialevent03',date,title:'Ve\u010de \u017eenskih autora',venue:'Kvaka 22',time:'21:00'},
 {_id:'materialevent04',date,title:'SWEENEY TODD',venue:'La Variete',time:'21:30'},
].map(event=>({...event,timeSource:'caption',timeStatus:'confirmed'}));
const triangleChecks=state=>{
 const vs=state.vertices,stride=state.grid.columns+1;let minimum=Infinity;
 for(let j=0;j<state.grid.rows;j++)for(let i=0;i<state.grid.columns;i++){
  const a=vs[j*stride+i],b=vs[j*stride+i+1],c=vs[(j+1)*stride+i],d=vs[(j+1)*stride+i+1];
  for(const[p,q,r]of((i+j)%2?[[a,b,c],[b,d,c]]:[[a,b,d],[a,d,c]])){
   const source=(q.sourceX-p.sourceX)*(r.sourceY-p.sourceY)-(q.sourceY-p.sourceY)*(r.sourceX-p.sourceX);
   const target=(q.tx-p.tx)*(r.ty-p.ty)-(q.ty-p.ty)*(r.tx-p.tx),jacobian=target/source;
   assert.ok(jacobian>.1,'mesh triangles must retain orientation and useful area');minimum=Math.min(minimum,jacobian);
  }
 }
 return minimum;
};
function phoneFrame(scene,assets,t,variant,backgroundOnly=false){
 const canvas=createCanvas(360,640),ctx=canvas.getContext('2d');ctx.scale(1/3,1/3);drawFrame(ctx,scene,assets,t,variant,{backgroundOnly});return new Uint8Array(ctx.getImageData(0,0,360,640).data);
}
function changedFraction(a,b){
 let changed=0,pixels=0;
 for(let y=0;y<640;y++)for(let x=0;x<360;x++)if(y<70||x>=315||y>=525){
  const k=(y*360+x)*4;assert.equal(a[k+3],255);assert.equal(b[k+3],255);
  if(Math.max(...[0,1,2].map(c=>Math.abs(a[k+c]-b[k+c])))>12)changed++;pixels++;
 }
 return changed/pixels;
}

const checks=[],pixelChecks=[];let publishDate='2026-10-19',readingFrames=0,meshTriangles=0;
for(let day=0;day<81;day++,publishDate=getNextIsoDate(publishDate)){
 const date=getNextIsoDate(publishDate),events=facts(date),theme=getPosterDirection(date,0,'reel',publishDate);
 assert.equal(theme.id,POSTER_FAMILIES[day%27].id);assert.equal(theme.composition,Math.floor(day/27));
 const art=buildPosterArtwork({date,events,position:0,format:'reel',publishDate}),closing=buildPosterClosing(publishDate);
 assert.equal(art.rows.length,4);assert.deepEqual(closing.bounds.map(b=>b.text),expectedCta);
 assert.ok(art.bounds.every(safe));
 for(const b of closing.bounds)assert.ok(safe({...b,x:10+b.x*.92,y:290+b.y*.92,width:b.width*.92,height:b.height*.92}));
 const scene={id:theme.id,family:theme.id,format:'reel',width:1080,height:1920,theme:art.theme,rows:art.rows,bounds:art.bounds,publishDate};
 assert.equal(getMaterialArchetype(scene),MATERIAL_ARCHETYPES[theme.id]);
 const variantFingerprints=[],heroFingerprints=[];
 for(let variant=0;variant<3;variant++){
  let minimumGap=Infinity,minimumJacobian=Infinity,maxBodyDisplacement=0,maxDx=0,maxDy=0;
  for(let frame=Math.ceil(READING_START*FPS);frame<=Math.floor(READING_END*FPS);frame++){
   const state=getMotionState(scene,frame/FPS,variant);
   assert.deepEqual([state.backgroundScale,state.backgroundRotation,state.backgroundDx,state.backgroundDy],[1.04,0,0,0]);
   assert.equal(state.phase,'reading');assert.equal(state.variant,variant);
   const moved=[];
   for(const[i,row]of art.rows.entries()){
    const motion=state.rows[i];assert.deepEqual([motion.textScale,motion.textRotation,motion.textOpacity,motion.timeWidth,motion.timeHeight],[1,0,1,168,108]);
    assert.equal(motion.textDx,motion.dx);assert.equal(motion.textDy,motion.dy);
    assert.ok(safe({x:row.timeX+motion.textDx,y:row.timeY+motion.textDy,width:168,height:108}));
    maxDx=Math.max(maxDx,Math.abs(motion.dx));maxDy=Math.max(maxDy,Math.abs(motion.dy));moved.push(motion.geometry);
   }
   for(let i=1;i<moved.length;i++)minimumGap=Math.min(minimumGap,moved[i].top-moved[i-1].top-moved[i-1].height);
   for(const b of art.bounds){const index=art.rows.findIndex(row=>b.y>=row.top-.01&&b.y+b.height<=row.top+row.height+.01),motion=index<0?{textDx:0,textDy:0}:state.rows[index];assert.ok(safe({...b,x:b.x+motion.textDx,y:b.y+motion.textDy}),'moving native glyphs must stay clear of Instagram controls');}
   assert.ok(state.material.maxBodyDisplacement<3);maxBodyDisplacement=Math.max(maxBodyDisplacement,state.material.maxBodyDisplacement);readingFrames++;
  }
  assert.ok(minimumGap>4);assert.ok(maxDx<=5.3&&maxDy<=2.3);
  const states=[];
  for(const t of [0,.25,1,2,3,6,9,13.2,15,17+29/30]){
   const material=getMaterialState(scene,t,variant);minimumJacobian=Math.min(minimumJacobian,triangleChecks(material));meshTriangles+=material.grid.triangles;
   assert.equal(material.family,theme.id);assert.equal(material.fixedScale,1.04);assert.equal(material.rotation,0);
   for(const vertex of material.vertices){assert.ok(Number.isFinite(vertex.tx)&&Number.isFinite(vertex.ty));if(vertex.boundary)assert.deepEqual([vertex.dx,vertex.dy],[0,0]);}
   assert.ok(material.hero.bounds.top>=1740);assert.equal(material.hero.spine.length,2);
   if(t===0)assert.deepEqual([material.hero.progress,material.hero.alpha],[0,0]);
   if(t>=2)assert.deepEqual([material.hero.progress,material.hero.alpha],[1,1]);
   states.push({vertices:material.vertices.map(p=>[p.tx,p.ty]),controls:material.controls,hero:material.hero.spine});
  }
  variantFingerprints.push(sha(JSON.stringify(states)));heroFingerprints.push(sha(JSON.stringify(states.map(s=>s.hero))));
  checks.push({family:theme.id,composition:theme.composition,variant,publicationDate:publishDate,minimumGap,minimumJacobian,maxBodyDisplacement,maxDx,maxDy,materialFingerprint:variantFingerprints.at(-1),heroFingerprint:heroFingerprints.at(-1)});
 }
 assert.equal(new Set(variantFingerprints).size,3);assert.equal(new Set(heroFingerprints).size,3);
 // One real native scene for every family exercises all three physical
 // variants through the Canvas renderer, including its transparent CTA.
 if(day<27){
  const prepared=await prepareDailyAgendaScene({date,events,position:0,format:'reel',publishDate});
  assert.equal(prepared.variant,getPosterDesignReceipt(date,0,'reel',publishDate).motionVariant);
  assert.equal(prepared.scene.publishDate,publishDate);assert.equal(prepared.scene.theme.id,theme.id);
  const foregroundCanvas=createCanvas(1080,1920),foreground=foregroundCanvas.getContext('2d');foreground.drawImage(prepared.assets.cta,0,0,1080,1920);
  const rgba=foreground.getImageData(0,0,1080,1920).data;let clear=0;
  for(let k=3;k<rgba.length;k+=4)if(rgba[k]===0)clear++;
  assert.ok(clear/(1080*1920)>.6,'native CTA must expose the live material');
  const images=[];
  for(let variant=0;variant<3;variant++){
   const {scene:preparedScene,assets}=prepared,bareAssets={background:assets.background,Path2D:assets.Path2D};
   const six=phoneFrame(preparedScene,bareAssets,6,variant,true),nine=phoneFrame(preparedScene,bareAssets,9,variant,true);
   const empty=phoneFrame({...preparedScene,rows:[]},bareAssets,6,variant,true);
   assert.equal(sha(six),sha(empty),'background-only mode must work without event/header/CTA assets');
   const programmeMotion=changedFraction(six,nine),ctaMotion=changedFraction(phoneFrame(preparedScene,assets,15,variant),phoneFrame(preparedScene,assets,17,variant));
   assert.ok(programmeMotion>.03,'material must visibly change at phone size');assert.ok(ctaMotion>.015,'CTA material must continue moving');
   for(const t of [13.25,13.7,14.1]){
    const transition=phoneFrame(preparedScene,assets,t,variant);
    assert.equal(transition[3],255,'every CTA transition branch must render an opaque frame');
   }
   images.push(six);pixelChecks.push({family:theme.id,variant,programmeMotion,ctaMotion,transparentCtaFraction:clear/(1080*1920)});
  }
  for(let a=0;a<3;a++)for(let b=a+1;b<3;b++)assert.ok(changedFraction(images[a],images[b])>.02,'actual material variants must look different');
 }
}
assert.equal(checks.length,243);assert.equal(pixelChecks.length,81);assert.equal(readingFrames,81*3*337);
const explicit='2026-10-21';
for(const[format,date,position]of[['story',explicit,0],['reel','2026-10-22',0],['feed','2026-10-23',0],['feed','2026-10-24',1]]){
 assert.equal(resolvePosterPublicationDate(date,position,format,explicit),explicit);
 assert.equal(publicationDateFor({date,position,format,publishDate:explicit}),explicit);
 assert.equal(getPosterDesignReceipt(date,position,format,explicit).key,getPosterDesignReceipt(explicit,0,'story',explicit).key);
}
for(const invalid of ['2026-02-29','2026-13-01','','2026-10-21T00:00:00Z'])assert.throws(()=>resolvePosterPublicationDate('2026-10-22',0,'reel',invalid),/Invalid/);
const result={status:'passed',designVersion:SOCIAL_DESIGN_VERSION,families:27,compositions:3,motionVariants:3,semanticCombinations:checks.length,readingFrames,meshTriangles,pixelCombinations:pixelChecks.length,renderedCtaTransitionFrames:27*3*3,durationSeconds:Number(((performance.now()-started)/1000).toFixed(2)),checks,pixelChecks};
await writeFile(path.join(output,'verification.json'),JSON.stringify(result,null,2)+'\n');
console.log(`Material motion QA passed: all 27 families, 243 composition/motion combinations, ${readingFrames} reading frames, ${meshTriangles} positive triangles and 81 native phone/CTA checks.`);
