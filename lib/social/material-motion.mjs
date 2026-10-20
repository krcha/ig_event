// Universal Canvas2D: no DOM/Node imports, used by browser and @napi-rs/canvas.
// Native text is always drawn at 1:1, upright. getMotionState reports absolute
// panel paths plus native-content translations for independent bounds checks.
import {drawMaterialBackground, getMaterialState, getMaterialArchetype} from './material-background.mjs';
export {getMaterialState};
export const DURATION=18, FPS=30, READING_START=2, READING_END=13.2;
const PI=Math.PI;
const clamp=(v,a=0,b=1)=>Math.min(b,Math.max(a,v));
const smooth=v=>{v=clamp(v);return v*v*(3-2*v);};
const ease=v=>1-(1-clamp(v))**4;
const mix=(a,b,t)=>a+(b-a)*t;
const num=v=>Number(v.toFixed(3));
const ARRIVALS=[['grow','split','trace'],['curl','split','weave'],['trace','split','weave'],['curl','split','trace'],['split','weave','trace'],['grow','split','weave']];
const familyIndex=getMaterialArchetype;
const rowGeometry=row=>row.layout||row;

function hull(r,amount,wave,curl,fi,v){
  const {x,y,w,h}=r, radius=fi===4?13:fi===1?31:fi===5?29:24;
  const q=1-amount, spine=x+w*(v===1?.42:.62), grow=v===0||v===2;
  let left=x,right=x+w,top=y,bottom=y+h;
  if(grow&&amount<1){left=mix(spine,x,amount);right=mix(spine,x+w,amount);top=mix(y+h*.52,y,amount);bottom=mix(y+h*.52,y+h,amount);}
  const rx=Math.min(radius,(right-left)*.27),ry=Math.min(radius,(bottom-top)*.27);
  const b=wave+q*(fi===1?44:fi===2?-37:30),c=curl+q*(fi===5?65:fi===3?-58:48);
  return `M${num(left+rx)} ${num(top)} C${num(left+w*.26)} ${num(top-b)} ${num(right-w*.24)} ${num(top+b*.64)} ${num(right-rx)} ${num(top)} Q${num(right+c*.18)} ${num(top)} ${num(right)} ${num(top+ry)} C${num(right+c)} ${num(top+h*.3)} ${num(right-c*.34)} ${num(bottom-h*.25)} ${num(right)} ${num(bottom-ry)} Q${num(right)} ${num(bottom)} ${num(right-rx)} ${num(bottom)} C${num(right-w*.2)} ${num(bottom+b)} ${num(left+w*.29)} ${num(bottom-b*.66)} ${num(left+rx)} ${num(bottom)} Q${num(left-c*.12)} ${num(bottom)} ${num(left)} ${num(bottom-ry)} C${num(left-c*.5)} ${num(bottom-h*.28)} ${num(left+c*.2)} ${num(top+h*.24)} ${num(left)} ${num(top+ry)} Q${num(left)} ${num(top)} ${num(left+rx)} ${num(top)}Z`;
}

/**
 * State contract: backgroundScale is a FIXED 1.04 overscan, rotation is zero.
 * Actual background motion is reported by material, never a camera zoom.
 * rows[].dx/dy move panel and all native content together. textDx/textDy include
 * the entrance-only nudge; from READING_START they are exactly dx/dy. Content
 * has textScale=1,textRotation=0,timeWidth=168,timeHeight=108 in every frame.
 * panelPath uses absolute poster coordinates and only its material rim bends.
 * phase,signature,arrival identify actual choreography, not palette variants.
 */
export function getMotionState(scene,time,variant=0){
  const t=clamp(Number(time)||0,0,DURATION-1/FPS),v=clamp(Math.trunc(Number(variant)||0),0,2),fi=familyIndex(scene);
  const rhythm=scene.format==='story'?1.035:1, ready=smooth((t-1.65)/.35);
  const backgroundScale=1.04;
  const backgroundRotation=0;
  const ctaProgress=smooth((t-READING_END)/(v===0?1.14:v===1?1.28:1.38));
  const rows=(scene.rows||[]).map((row,i)=>{
    const r=rowGeometry(row),start=.06+i*(v===2?.125:.145),u=clamp((t-start)/(v===1?1.22:1.16));
    const arrival=ARRIVALS[fi][v],e=ease(u),phase=i*.94+fi*.38+v*.7;
    const driftX=ready*(3.6*Math.sin(t*.47*rhythm+phase)+1.2*Math.sin(t*.83+phase*1.8));
    const driftY=ready*(1.65*Math.sin(t*.57*rhythm+phase)+.45*Math.sin(t*.91+v));
    const contentOpacity=smooth((u-.4)/.48),nudged=1-ease(clamp((u-.35)/.65));
    const dx=driftX,dy=driftY;
    const wave=(.7+.15*fi)*Math.sin(t*.76+i*.8+v)*ready;
    const curl=(1.2+.1*fi)*Math.sin(t*.52+i*1.1+v)*ready;
    const rimExcursion=Math.abs(wave)+Math.abs(curl)+1;
    const g={x:r.x+dx-rimExcursion,top:r.top+dy-rimExcursion,width:r.width+rimExcursion*2,height:r.height+rimExcursion*2};
    const growth=arrival==='grow'||arrival==='curl'?e:1;
    return {dx:num(dx),dy:num(dy),textDx:num(dx+(v===1?(i%2?-1:1):0)*13*nudged),textDy:num(dy+10*nudged),textOpacity:contentOpacity,opacity:smooth(u/.27),panelPath:hull({x:r.x,y:r.top,w:r.width,h:r.height},growth,wave,curl,fi,v),entrance:u,arrival,curl,wave,scaleX:1,scaleY:1,rotation:0,textScale:1,textRotation:0,timeWidth:168,timeHeight:108,geometry:g};
  });
  return {time:t,variant:v,variantId:String(v+1).padStart(2,'0'),signature:`${scene.family||scene.id}/${ARRIVALS[fi][v]}/${v}`,phase:t<READING_START?'opening':t<=READING_END?'reading':ctaProgress<1?'closing':'cta',backgroundScale,backgroundRotation,backgroundDx:0,backgroundDy:0,rows,ctaProgress,ctaOpacity:ctaProgress,material:getMaterialState(scene,t,v)};
}

function stroke(ctx,Path,d,color,width=2,alpha=1,progress=1,offset=0,dashed=false){
  if(alpha<=0||progress<=0)return;
  ctx.save();ctx.strokeStyle=color;ctx.lineWidth=width;ctx.lineCap='round';ctx.lineJoin='round';ctx.globalAlpha*=alpha;
  if(progress<1){ctx.setLineDash([Math.max(1,2300*progress),2500]);ctx.lineDashOffset=-offset;}else if(dashed){ctx.setLineDash([2,9]);ctx.lineDashOffset=-offset;}
  ctx.stroke(new Path(d));ctx.restore();
}

function organicClip(ctx,Path,progress,v,fi,closing=false){
  const p=ease(progress);if(p>=.999){ctx.rect(-20,-20,1120,1960);return;}
  if(v===0){
    const cx=fi===2?1070:fi===0?1060:980,cy=closing?1010:fi===0?1760:fi===1?700:1390;
    const rx=25+p*1930,ry=20+p*2500,swirl=(1-p)*(fi===1?160:80);
    const d=`M${cx} ${cy-ry} C${cx+rx} ${cy-ry+swirl} ${cx+rx*.85} ${cy+ry*.75} ${cx} ${cy+ry} C${cx-rx*.87} ${cy+ry*.55} ${cx-rx} ${cy-ry*.9} ${cx} ${cy-ry}Z`;
    ctx.addPath?.(new Path(d));return d;
  }
  if(v===1){
    const x=1140-p*2390,curve=Math.sin(p*PI)*260;
    return `M${x+curve} -80 C${x-curve} 410 ${x+curve*.85} 1130 ${x-curve*.4} 2010 L1190 2010 L1190 -80Z`;
  }
  let d='';for(let k=0;k<9;k++){
    const q=ease(clamp(progress*1.28-k*.035)),y=k*225-15,cut=1150-q*2250,curve=(1-q)*110;
    if(k%2)d+=`M${-60} ${y} L${1080-cut} ${y} Q${1080-cut+curve} ${y+110} ${1080-cut} ${y+245} L-60 ${y+245}Z`;
    else d+=`M${cut} ${y} Q${cut-curve} ${y+110} ${cut} ${y+245} L1150 ${y+245} L1150 ${y}Z`;
  }return d;
}


function imageAtCrop(ctx,image,crop){ctx.drawImage(image,crop.left,crop.top,crop.width,crop.height);}
function drawRow(ctx,scene,assets,state,index){
  const row=scene.rows[index],r=rowGeometry(row),st=state.rows[index],images=assets.rows[index],crop=row.crop||{left:r.x-10,top:r.top-10,width:r.width+20,height:r.height+20},Path=assets.Path2D;
  const a=scene.theme,fi=familyIndex(scene),u=st.entrance,e=ease(u),q=1-e;
  ctx.save();ctx.translate(st.dx,st.dy);ctx.globalAlpha*=st.opacity;
  const panelPath=new Path(st.panelPath),paintPanel=()=>{
    ctx.save();ctx.clip(panelPath);
    const fills=a.rowFills||a.colors||[a.paper];
    ctx.fillStyle=row.fill||(scene.panelDark?a.dark:fills[index%fills.length])||a.paper;ctx.fillRect(r.x-60,r.top-60,r.width+120,r.height+120);
    imageAtCrop(ctx,images.panel,crop);ctx.restore();
  };
  if(st.arrival==='split'&&u<1){
    for(let k=0;k<2;k++){
      const side=k?1:-1;ctx.save();ctx.translate(side*85*q,(k?1:-1)*12*q);ctx.beginPath();const cut=r.x+r.width*.49;
      const d=k?`M${cut} ${r.top-60} C${cut+80*q} ${r.top+r.height*.25} ${cut-70*q} ${r.top+r.height*.7} ${cut} ${r.top+r.height+60} L1200 ${r.top+r.height+60} L1200 ${r.top-60}Z`:`M${cut+2} ${r.top-60} C${cut+2+80*q} ${r.top+r.height*.25} ${cut+2-70*q} ${r.top+r.height*.7} ${cut+2} ${r.top+r.height+60} L-100 ${r.top+r.height+60} L-100 ${r.top-60}Z`;
      ctx.clip(new Path(d));paintPanel();ctx.restore();
    }
  }else if(st.arrival==='weave'&&u<1){
    for(let k=0;k<7;k++){
      const p=ease(clamp(u*1.3-k*.042)),dir=k%2?1:-1,sy=r.top+k*r.height/7,sh=r.height/7+2,offset=(1-p)*125*dir;
      ctx.save();ctx.translate(offset,(1-p)*(k-3)*5);const d=`M${r.x-25} ${sy} Q${r.x+r.width*.5} ${sy+(1-p)*22} ${r.x+r.width+25} ${sy} L${r.x+r.width+25} ${sy+sh} Q${r.x+r.width*.5} ${sy+sh-(1-p)*15} ${r.x-25} ${sy+sh}Z`;ctx.clip(new Path(d));paintPanel();ctx.restore();
    }
  }else if(st.arrival==='trace'&&u<.75){
    ctx.save();ctx.globalAlpha*=smooth((u-.16)/.47);paintPanel();ctx.restore();stroke(ctx,Path,st.panelPath,a.ink,fi===4?2:1.7,.5,ease(u/.68));
  }else paintPanel();
  // A local light catches the bending edge; its inner field is always opaque.
  ctx.save();ctx.globalAlpha*=fi===1?.7:.15;ctx.strokeStyle=fi===1?a.paper:a.ink;ctx.lineWidth=fi===1?1.6:.9;ctx.stroke(panelPath);ctx.restore();
  if((st.arrival==='curl'||st.arrival==='grow')&&u<.92){
    const xx=r.x+r.width*(.55+.4*e),yy=r.top+r.height*.48;stroke(ctx,Path,`M${xx} ${r.top+4} C${xx+q*95} ${yy-70} ${xx-q*110} ${yy+70} ${xx} ${r.top+r.height-4}`,a.paper,1.4,q*.65);
  }
  ctx.restore();
  // This pass never uses the panel's bend, clip, scale or rotation.
  ctx.save();ctx.translate(st.textDx,st.textDy);ctx.globalAlpha*=st.textOpacity;imageAtCrop(ctx,images.content,crop);ctx.restore();
}

function drawClosing(ctx,scene,assets,state){
  const p=state.ctaProgress;if(p<=0)return;const fi=familyIndex(scene),v=state.variant;
  ctx.save();ctx.beginPath();const d=organicClip(ctx,assets.Path2D,clamp((state.time-READING_END)/(v===0?1.14:v===1?1.28:1.38)),v,fi,true);
  if(d)ctx.clip(new assets.Path2D(d));else ctx.clip();
  if(p<1)drawMaterialBackground(ctx,scene,assets,state.time,v);
  ctx.drawImage(assets.cta,0,0,1080,1920);ctx.restore();
  if(p<.99&&v===1){
    const x=1140-ease((state.time-READING_END)/1.28)*2390,b=Math.sin(p*PI)*260;
    stroke(ctx,assets.Path2D,`M${x+b} -80 C${x-b} 410 ${x+b*.85} 1130 ${x-b*.4} 2010`,scene.theme.paper,3,Math.sin(p*PI)*.4);
  }
}

export function drawFrame(ctx,scene,assets,time,variant=0,options={}){
  const state=getMotionState(scene,time,variant);
  ctx.save();ctx.clearRect(0,0,scene.width||1080,scene.height||1920);ctx.imageSmoothingEnabled=true;
  drawMaterialBackground(ctx,scene,assets,state.time,state.variant);
  if(options.backgroundOnly){ctx.restore();return state;}
  if(state.ctaProgress<1){
    ctx.save();const fade=smooth(state.time/.7);ctx.globalAlpha*=fade;ctx.translate(0,-9*(1-ease(state.time/.95)));ctx.drawImage(assets.header,0,0,1080,1920);ctx.restore();
    for(let i=0;i<scene.rows.length;i++)drawRow(ctx,scene,assets,state,i);
  }
  drawClosing(ctx,scene,assets,state);ctx.restore();return state;
}
