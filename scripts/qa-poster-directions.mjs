import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { SOCIAL_DESIGN_VERSION, POSTER_FAMILIES, POSTER_CYCLE_LENGTH, getPosterDirection, getPosterDesignReceipt } from '../lib/social/poster-directions.ts';
import { buildPosterArtwork, buildPosterClosing } from '../lib/social/poster-renderer.ts';
import { getNextIsoDate } from '../lib/social/daily-carousel.ts';

const started=performance.now(),root=path.resolve('out/art-direction-production/proof');await mkdir(root,{recursive:true});
const manifest=JSON.parse(await readFile('public/social/art-directions/manifest.json','utf8'));
assert.equal(POSTER_FAMILIES.length,27);assert.equal(manifest.assets.length,27);assert.equal(POSTER_CYCLE_LENGTH,81);
assert.equal(SOCIAL_DESIGN_VERSION,'27-material-motion-20261020-v4');
assert.equal(new Set(POSTER_FAMILIES.map(family=>family.id)).size,27);
assert.deepEqual(manifest.assets.map(asset=>asset.id),POSTER_FAMILIES.map(family=>family.id));
const originalHashes=[
 '6badd504fc7149997da76168e6e917759a8ecd4b28b811bbaa16c618dc11a341',
 '998204173536721bfe6c5430967f5109148441681a88ec61ad9734210eb771c6',
 '8088da2385403a50f494d1adb4136b1dc63944f5a390ee7a3bcad3439109ad10',
 '2d48a68637f235a6d15ba185563830ce9a290f6750e5dde9f63726094ba6f4f4',
 '3a8aac401ae98b5c80c4545cb7bdf17fd76acbbb177490f8bf1935ed0887ac41',
 'c09ddb6870520e15c2e21a9ac9db58b28dc2b8e1e42ebf6d9787d2792261d251',
 'd4d8f397d71b3053b89aa6d22532db0819d88f69521611a33da295268a9cd1e1',
 '702a5306cde80697263c4c9a2af278ad8b910d48f67c8b0242cb5b8de4b258aa',
 '820e8699d49009c17f746d7d349c0e5f72935b1d004b4ddf91f0669961832dfd',
 '4ef9407dc3a0260bf74cf4675018112399745d3175a13f8a58a53da429abf6d3',
 '003af42698d7f32c708d39c589a9308caab1730176315f3717403eba8ba039d4',
 '9fbbdebd4afdc84e1359d52e7dded01a19af18237e45b3784f95b414005084fd',
 '975e49f0412e7c081d8383778590bc125462a02c7af2728b9a23f3b3fcdf9786',
 'bf6d8488e2cf551407f6ddb6c548b15993b4f82c2afc28e5242348ed843dfc58',
 '089dc0b8432679fdae38f282438c193de66c17fd4f208776a1149a764b278b28',
 'f09dbdba6fa76c18384aff002e8e5d7fd6be2b22fbfc85141a992de3307ce940',
 '141a628adad1d79e140d96b15e16aa51d2d52317254dbce4a12ea266060bb7f2',
 'f6f430143cb4b258ad8f990fa831d2335aa8742611f71d637c8c80d1befa6ade',
 '609280002602156f1b0bb88ae7bf7e7d5709f9ab28a0d872cc7ca14934eda0ce',
 '6103c34e4cef1c78bddf15f22108bb8c3bb67b906ce3b3ba4d3015632e9d261f',
];
const originalBytes=[834783,440404,793505,749326,715961,594772,627816,340944,673569,780574,395931,711290,555487,604456,768076,456009,819017,648389,672620,446941];
// These hashes and byte counts are pinned from the user's approved pack03,
// including its final refined Karminski odjek rather than an earlier study.
const approvedPack03=[
 ['crni-kadar','6faa3637a3419200c27f3b3233035e97fc8fe71e7eb10ea26afd868324c19b54',1236194],
 ['crvena-margina','60773093834146b08f5b9e8b1ac5b5e0da4cd3369162f4c693369f0430a4c901',1479364],
 ['kabinet-tusa','671781dbc54791cef60430590d1b64f02abf2be8aceed83bbec496886e73c3e7',1406940],
 ['plavi-bakrorez','8cb917fe4a2baaaa6e085a9a3abd40c4bfefff84e65a1bbbbfe6f2695fe6790c',1856583],
 ['ljubicasti-kontakt','16508e6fc83974cf9edca0348a447bac869c8588d7ab9e0fb79ebf6a8c285f45',1068765],
 ['zeleni-fanzin','d59db5e942297d97a02f4e2f2056659d95a4960f80ae0c19427c4f542d1346d6',1845541],
 ['karminski-odjek','abecf4e99b68a68b0cb86725ddef24b602a4dbb12fcf3b9c94a7e08eec31a6fe',1295589],
];
for(const asset of manifest.assets){
 const bytes=await readFile('public/social/art-directions/'+asset.file),hash=createHash('sha256').update(bytes).digest('hex');
 assert.equal(hash,asset.sha256);assert.equal(bytes.length,asset.bytes);
 if(Number(asset.id)<=20){
  assert.equal(hash,originalHashes[Number(asset.id)-1],'all twenty existing approved artworks must remain byte-identical');
  assert.equal(bytes.length,originalBytes[Number(asset.id)-1]);
 }else{
  const [key,approvedHash,approvedBytes]=approvedPack03[Number(asset.id)-21];
  assert.equal(asset.key,key);assert.equal(hash,approvedHash,'production must use the exact approved pack03 JPEG');assert.equal(bytes.length,approvedBytes);
  assert.equal(asset.approvedPreview,'poster-pack-03-2026-10-19');assert.equal(asset.previewId,String(Number(asset.id)-20).padStart(2,'0'));
  const family=POSTER_FAMILIES.find(family=>family.id===asset.id);assert.equal(family.compositionStyle,'material');assert.equal(family.rowFills.length,4);
 }
 const metadata=await sharp(bytes).metadata();assert.equal(metadata.format,'jpeg');assert(metadata.width>=1080&&metadata.height>=1350);
}
const fixture=(date,count,long=false)=>Array.from({length:count},(_,i)=>({_id:'posterfixture'+i,date,
 title:(long?['Predavanje i razgovor: kako grad menja naš svakodnevni život i gde se sreću muzika, umetnost i javni prostor','Matija Rado b2b lu:ka & prijatelji: muzika na pločama','Разговор о граду: где се сусрећу музика, уметност и свакодневни живот','Andrija Dabanović: Nezavisan']:['Jam session','Matija Rado b2b lu:ka','The Science of Sleep','Veče ženskih autora'])[i],
 venue:['Baza','Kulturni centar Beograda','Kvaka 22','Stand Up Ben Akiba'][i],time:['12:00–18:00','20:00','21:30',''][i],timeSource:'caption',timeStatus:'confirmed',ticketPrice:i===0?'Preporučeni prilog 500 RSD':undefined}));
const identity=value=>value.replace(/\s+/gu,'');
function checkLayout(art,events,format){
 const vertical=format!=='feed',svg=art.svg.toString();
 assert(!art.bounds.some(bound=>bound.role==='intro'),'no filler sentence may remain after the date');
 assert.doesNotMatch(svg,/data-role="intro"/u);
 for(const line of [art.theme.feedLine,art.theme.storyLine,art.theme.reelLine].filter(Boolean)){
  const escaped=line.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  assert(!svg.includes(`aria-label="${escaped}"`),'no family-specific intro may remain in SVG labels');
 }
 for(const [i,row]of art.rows.entries()){
  assert.equal(identity(row.title.lines.join(' ')),identity(events[i].title));
  assert.equal(identity(row.venue.lines.join(' ')),identity(events[i].venue));
  assert(row.timeX>=row.x&&row.timeX+168<=row.x+row.width&&row.timeY>=row.top&&row.timeY+108<=row.top+row.height);
 }
 assert(art.rows[0].top<=(vertical?556:366),'removed intro space becomes useful programme space');
 for(const bound of art.bounds)assert(bound.x>=48&&bound.x+bound.width<=(vertical?938:1030)&&bound.y>=(vertical?226:0)&&bound.y+bound.height<=(vertical?1560:1330));
 for(let i=0;i<art.bounds.length;i++)for(let j=i+1;j<art.bounds.length;j++){
  const a=art.bounds[i],b=art.bounds[j],w=Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x),h=Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y);
  assert(w<=1||h<=1,`text bounds overlap ${a.role}/${b.role}`);
 }
}
async function expectedArtwork(theme,height){
 const target=manifest.assets.find(asset=>asset.id===theme.id),source='public/social/art-directions/'+target.file;
 if(theme.compositionStyle!=='material'){
  const position=theme.composition===1?'left':theme.composition===2?'right':'centre';
  return sharp(source).resize(1080,height,{fit:'cover',position}).toBuffer();
 }
 if(theme.composition===1)return sharp(source).resize(1080,height,{fit:'cover',position:'centre'}).flop().toBuffer();
 if(theme.composition===2)return sharp(source).resize(1248,height+200,{fit:'cover',position:'right'}).extract({left:84,top:100,width:1080,height}).toBuffer();
 return sharp(source).resize(1080,height,{fit:'cover',position:'centre'}).toBuffer();
}
async function bareHash(svg){
 const prefix=svg.match(/^[\s\S]*?<image href="data:image\/jpeg;base64,[^"]+"[^>]*\/>(?:<\/g>)?/u)?.[0];
 assert(prefix,'poster must contain a raster background');
 const pixels=await sharp(Buffer.from(prefix+'</svg>')).resize(216,270,{fit:'fill'}).removeAlpha().raw().toBuffer();
 return createHash('sha256').update(pixels).digest('hex');
}
const seen={feed:new Set(),reel:new Set(),story:new Set()},receipts=[],bareHashes=new Map();
let publishDate='2026-10-19',textChecks=0,rasterProofs=0;
for(let n=0;n<81;n++,publishDate=getNextIsoDate(publishDate)) {
 const phases=[];
 for(const format of ['feed','reel','story']) {
  const date=format==='story'?publishDate:getNextIsoDate(publishDate),events=fixture(date,format==='feed'?3:4);
  const art=buildPosterArtwork({date,events,position:0,format,publishDate}),key=art.theme.id+'-'+art.theme.composition;
  assert(!seen[format].has(key),format+' repeated a combination before completing the cycle');seen[format].add(key);phases.push(key);
  const sequence=n%81;
  assert.equal(art.theme.id,POSTER_FAMILIES[sequence%27].id,'every rendered proof follows catalogue order');
  assert.equal(art.theme.composition,Math.floor(sequence/27));
  const receipt=getPosterDesignReceipt(date,0,format,publishDate);
  assert.equal(receipt.cycleLength,81);assert.equal(receipt.publishDate,publishDate);
  assert.equal(receipt.key,getPosterDesignReceipt(publishDate,0,'story',publishDate).key);
  assert.ok(Number.isInteger(receipt.motionVariant)&&receipt.motionVariant>=0&&receipt.motionVariant<3);
  checkLayout(art,events,format);
  assert.equal(art.rows.length,format==='feed'?3:4);
  assert.equal(new Set(art.theme.colors).size,4);
  const svg=art.svg.toString();assert.match(svg,/<image href="data:image\/jpeg;base64,/);assert(!svg.includes('<text'));
  assert.equal((svg.match(/width="168" height="108"/g)||[]).length,format==='feed'?3:4);
  if(format==='story')assert.match(svg,/aria-label="DANAS"/);if(format==='reel')assert.match(svg,/aria-label="SUTRA"/);
  const bytes=await sharp(art.svg).jpeg({quality:93,chromaSubsampling:'4:4:4'}).toBuffer(),m=await sharp(bytes).metadata();
  assert.equal(m.width,1080);assert.equal(m.height,format==='feed'?1350:1920);assert(bytes.length<8_000_000);
  const file=`${art.theme.id}-${art.theme.composition}-${format}.jpg`;await writeFile(path.join(root,file),bytes);textChecks+=art.bounds.length;rasterProofs++;
  // A raster background must actually decode in librsvg; unsupported image
  // formats can silently disappear. The right bleed contains only artwork.
  if(format!=='feed') {
    const area={left:950,top:0,width:130,height:1920};
    const target=manifest.assets.find(a=>a.id===art.theme.id),position=art.theme.composition===1?'left':art.theme.composition===2?'right':'centre';
    const expectedCrop=art.theme.compositionStyle==='material'
      ?await sharp(await expectedArtwork(art.theme,1920)).extract(area).toBuffer()
      :await sharp('public/social/art-directions/'+target.file).resize(1080,1920,{fit:'cover',position}).extract(area).toBuffer();
    const expected=await sharp(expectedCrop).resize(52,768).removeAlpha().raw().toBuffer();
    const actual=await sharp(bytes).extract(area).resize(52,768).removeAlpha().raw().toBuffer();
    const fallback=[0,2,4].map(offset=>parseInt(art.theme.bg.slice(1+offset,3+offset),16));
    let delta=0,flatDelta=0;for(let k=0;k<actual.length;k++){delta+=Math.abs(actual[k]-expected[k]);flatDelta+=Math.abs(fallback[k%3]-expected[k]);}
    assert(delta<flatDelta*.8,`Raster background did not decode closer to its source than a flat fallback ${key}/${format}`);
  }
  if(Number(art.theme.id)>=14&&format!=='story'){
   const k=art.theme.id+'/'+(format==='feed'?'feed':'vertical');
   if(!bareHashes.has(k))bareHashes.set(k,new Set());bareHashes.get(k).add(await bareHash(svg));
  }
  // Long names and Cyrillic exercise every family and composition without
  // abbreviating a factual identity. Optional detail can yield to full names.
  const long=buildPosterArtwork({date,events:fixture(date,format==='feed'?3:4,true),position:0,format,publishDate});
  checkLayout(long,fixture(date,format==='feed'?3:4,true),format);
  for(const event of fixture(date,format==='feed'?3:4,true)){
    const title=long.rows[fixture(date,format==='feed'?3:4,true).findIndex(e=>e._id===event._id)].title.lines.join('').replaceAll(' ','');
    assert.equal(title,event.title.replaceAll(' ',''));
  }
  textChecks+=long.bounds.length;
  if(format==='feed') {
    for(let p=1;p<3;p++) {
      const d=p===1?getNextIsoDate(date):getNextIsoDate(getNextIsoDate(date));
      const t=getPosterDirection(d,p,'feed',publishDate);assert.equal(t.id,art.theme.id);assert.equal(t.composition,art.theme.composition);
    }
    const closing=buildPosterClosing(publishDate);assert.equal(closing.theme.id,art.theme.id);assert.equal(closing.theme.composition,art.theme.composition);
    assert.equal(closing.theme.sequence,art.theme.sequence);
    assert(!closing.bounds.some(bound=>bound.role==='intro'));assert.doesNotMatch(closing.svg.toString(),/data-role="intro"/u);
    assert.match(closing.svg.toString(),/aria-label="Zeka"/u);assert.match(closing.svg.toString(),/eventzeka\.com/u);
    const quietLabels=[...closing.svg.toString().matchAll(/<rect[^>]*data-role="closing-reading-surface"[^>]*\/>/gu)].map(match=>match[0]);
    if(Number(art.theme.id)>=21){
      assert.equal(closing.theme.quietClosingLabels,true);assert.equal(quietLabels.length,2,'new-family CTA brand and footer retain the approved quiet reading surfaces');
      assert(quietLabels.some(label=>label.includes('data-label="brand"')));assert(quietLabels.some(label=>label.includes('data-label="footer"')));
      assert(quietLabels.every(label=>label.includes('opacity=".94"')));
    }else{
      assert(!closing.theme.quietClosingLabels);assert.equal(quietLabels.length,0,'existing twenty CTA layouts remain unchanged');
    }
    await writeFile(path.join(root,`${art.theme.id}-${art.theme.composition}-closing.jpg`),await sharp(closing.svg).jpeg({quality:93}).toBuffer());
    textChecks+=closing.bounds.length;rasterProofs++;
  }
  receipts.push({family:art.theme.id,name:art.theme.name,composition:art.theme.composition+1,format,date,publishDate,file,textChecks:art.bounds.length,overlaps:0,clipping:0,introAbsent:true});
 }
 assert.equal(new Set(phases).size,1,'all daily formats share their publication-day family and composition');
}
for(const format of Object.keys(seen))assert.equal(seen[format].size,81);
for(const [key,hashes]of bareHashes)assert.equal(hashes.size,3,'three distinct bare backgrounds required for '+key);
assert.equal(bareHashes.size,28,'all fourteen material families require feed and vertical background proofs');
for(const format of ['feed','reel','story']){
 const first=getPosterDirection(format==='story'?'2026-10-19':'2026-10-20',0,format,'2026-10-19');
 const repeated=getPosterDirection(format==='story'?publishDate:getNextIsoDate(publishDate),0,format,publishDate);
 assert.equal(repeated.id,first.id);assert.equal(repeated.composition,first.composition);
 assert.equal(getPosterDesignReceipt(format==='story'?'2026-10-18':'2026-10-19',0,format,'2026-10-18').cycleLength,39,'historical publication dates keep original cycle');
}
assert.throws(()=>getPosterDirection('2026-02-29'),/Invalid/);
assert.throws(()=>getPosterDirection('2026-10-19',3),/Invalid/);
assert.throws(()=>buildPosterArtwork({date:'2026-10-19',position:0,format:'story',events:fixture('2026-10-19',4).concat(fixture('2026-10-19',1))}),/one to four/);
assert.equal(rasterProofs,324);assert.equal(receipts.length,243);
const result={status:'passed',families:27,combinationsPerFormat:81,posters:rasterProofs,textChecks,overlaps:0,clipping:0,intros:0,preservedOriginalAssets:20,approvedPack03Assets:7,materialFamilies:14,distinctBareBackgroundsPerMaterialFamily:3,durationSeconds:Number(((performance.now()-started)/1000).toFixed(2)),preservedAssets:manifest.assets.slice(0,20).map(({id,sha256,bytes})=>({id,sha256,bytes})),approvedAssets:manifest.assets.slice(20).map(({id,sha256,bytes,approvedPreview,previewId})=>({id,sha256,bytes,approvedPreview,previewId})),receipts};
await writeFile(path.join(root,'verification.json'),JSON.stringify(result,null,2));
console.log(`Poster directions QA passed: 27 families, 81 combinations per format, 324 raster proofs, ${textChecks} text bounds, no intro copy, all 20 original assets preserved, seven exact approved pack03 assets, long Serbian/Cyrillic identities and decoded backgrounds.`);
