import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import * as fontkit from 'fontkit';

const root=path.resolve('public/social/special/2026-10-25');
const source=readFileSync(path.join(root,'source.png'));
const caption='Iza\u0111i i glasaj!';
const background='#e4e8f5';
const font=fontkit.openSync('public/fonts/social/InstrumentSans-Variable.ttf').getVariation({wght:650});
const run=font.layout(caption),scale=72/font.unitsPerEm;
let x=540-run.positions.reduce((sum,p)=>sum+p.xAdvance,0)*scale/2;
const letters=run.glyphs.map((glyph,index)=>{
  const p=run.positions[index];
  const item=`<path d="${glyph.path.toSVG()}" transform="translate(${x+p.xOffset*scale},${1530-p.yOffset*scale}) scale(${scale},${-scale})"/>`;
  x+=p.xAdvance*scale;return item;
}).join('');
const portrait=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920"><rect width="1080" height="1920" fill="${background}"/><image href="data:image/png;base64,${source.toString('base64')}" x="75" y="230" width="930" height="1174" preserveAspectRatio="xMidYMid meet"/><g fill="#ad1935">${letters}</g></svg>`);
await sharp(source).resize(1080,1350,{fit:'contain',background}).flatten({background}).toColourspace('srgb').jpeg({quality:95,chromaSubsampling:'4:4:4'}).toFile(path.join(root,'post.jpg'));
await sharp(portrait).toColourspace('srgb').jpeg({quality:95,chromaSubsampling:'4:4:4'}).toFile(path.join(root,'story.jpg'));
writeFileSync(path.join(root,'reel-cover.jpg'),readFileSync(path.join(root,'story.jpg')));
execFileSync(process.env.EVENTZEKA_FFMPEG_PATH||'ffmpeg',['-v','error','-y','-loop','1','-framerate','30','-i',path.join(root,'reel-cover.jpg'),'-f','lavfi','-i','anullsrc=r=48000:cl=stereo','-t','15','-vf','scale=in_range=pc:out_range=tv,format=yuv420p','-color_range','tv','-c:v','libx264','-preset','veryfast','-crf','18','-maxrate','6M','-bufsize','12M','-pix_fmt','yuv420p','-r','30','-g','60','-threads','2','-c:a','aac','-b:a','128k','-ar','48000','-ac','2','-movflags','+faststart','-use_editlist','0',path.join(root,'reel.mp4')],{timeout:120000});
const assets={};
for(const [key,file,type] of [['post','post.jpg','image/jpeg'],['story','story.jpg','image/jpeg'],['reel','reel.mp4','video/mp4'],['cover','reel-cover.jpg','image/jpeg']]){
  const bytes=readFileSync(path.join(root,file));
  const sha256=createHash('sha256').update(bytes).digest('hex');
  assets[key]={file,sha256,bytes:bytes.length,contentType:type,url:`https://eventzeka.com/api/social/special/2026-10-25/${file}?v=${sha256}`};
}
const manifest={id:'eventzeka-special-2026-10-25-v1',date:'2026-10-25',timezone:'Europe/Belgrade',scheduledLocalTime:'10:00',scheduledUtc:'2026-10-25T09:00:00Z',caption,sourceSha256:createHash('sha256').update(source).digest('hex'),locationId:'109920975697736',locationName:'Belgrade, Serbia',shareToFeed:false,durationSeconds:15,assets};
writeFileSync(path.join(root,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({id:manifest.id,sourceSha256:manifest.sourceSha256,files:Object.values(assets).map(a=>({file:a.file,bytes:a.bytes}))}));
