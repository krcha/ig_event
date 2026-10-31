// Shared production material engine. Universal Canvas2D, with continuously deformed
// native material plus evolving vector geometry. No DOM, Node, WebGL or fonts.
// Readable type and native event cards are painted separately by the caller.
const PI=Math.PI,TAU=PI*2,NX=12,NY=20,W=1080,H=1920,OVERSCAN=1.04;
const clamp=(v,a=0,b=1)=>Math.min(b,Math.max(a,v));
const smooth=v=>{v=clamp(v);return v*v*(3-2*v);};
const ease=v=>1-(1-clamp(v))**4;
// Every existing family keeps its own artwork, fonts and palette. Archetypes
// select only the physical choreography used to deform that material.
export const MATERIAL_ARCHETYPES={
  '01':4,'02':1,'03':0,'04':4,'05':1,'06':3,'07':0,'08':5,'09':1,
  '10':2,'11':3,'12':3,'13':4,'14':1,'15':5,'16':1,'17':4,'18':3,
  '19':4,'20':1,'21':1,'22':2,'23':3,'24':3,'25':5,'26':4,'27':5,
};
export const getMaterialArchetype=s=>MATERIAL_ARCHETYPES[s.family||s.id]??0;
const familyOf=getMaterialArchetype;
const color=(c,a)=>{if(/^#[a-f\d]{6}$/i.test(c||'')){const s=c.slice(1);return `rgba(${parseInt(s.slice(0,2),16)},${parseInt(s.slice(2,4),16)},${parseInt(s.slice(4,6),16)},${a})`;}return c||'#fff';};

function weightAt(x,y){
  const right=smooth((x-900)/155),left=.6*smooth((72-x)/100),top=.94*smooth((230-y)/220),bottom=smooth((y-1570)/255);
  return Math.max(right,left,top,bottom);
}

/**
 * QA state: vertices are shared by adjacent triangles (no independent tiles).
 * sourceX/sourceY refer to the native raster; x/y are overscanned positions;
 * dx/dy are the actual additional material displacement, tx/ty the result.
 * The outer boundary is stationary. The central reading region stays <3px.
 * signature names actual warp fields and vector forms, never a color change.
 */
export function getMaterialState(scene,time,variant=0){
  const t=Math.max(0,Number(time)||0),v=clamp(Math.trunc(Number(variant)||0),0,2),fi=familyOf(scene),opening=1-ease(t/2);
  const amplitude=(fi===1?68:fi===4?53:62)*(1+.22*opening),phase=t*(v===0?.57:v===1?.69:.48)+fi*.63;
  const vertices=[];let maxDisplacement=0,maxBodyDisplacement=0;
  for(let j=0;j<=NY;j++)for(let i=0;i<=NX;i++){
    const sourceX=i*W/NX,sourceY=j*H/NY,x=540+(sourceX-540)*OVERSCAN,y=960+(sourceY-960)*OVERSCAN;
    const weight=weightAt(x,y),boundary=i===0||j===0||i===NX||j===NY;
    let dx,dy;
    if(v===0){dx=amplitude*(Math.sin(y*.0047-phase)+.2*Math.sin(x*.006+y*.002+phase*.7))/1.2;dy=amplitude*.65*Math.cos(y*.0031+phase*.83+x*.0015);}
    else if(v===1){dx=amplitude*Math.sin(y*.0058+phase)*Math.cos(x*.0014-phase*.3);dy=amplitude*.72*Math.sin(y*.004-phase*.91+x*.003);}
    else{dx=amplitude*Math.sin(y*.0067-phase)*Math.cos(y*.0016+phase*.57);dy=amplitude*.7*Math.sin(x*.004+y*.0034+phase*.83);}
    dx=boundary?0:dx*weight+1.05*Math.sin(y*.002+phase)*(.8-weight*.5);
    dy=boundary?0:dy*weight+.8*Math.cos(x*.003-phase)*(.8-weight*.5);
    const rawMagnitude=Math.hypot(dx,dy),radialLimit=64.5+14*opening;
    if(rawMagnitude>radialLimit){dx*=radialLimit/rawMagnitude;dy*=radialLimit/rawMagnitude;}
    // Pin the outermost cell against a corner fold. Shared vertices keep every
    // seam continuous; component limits retain a positive triangle Jacobian.
    const limitX=Math.min(64+12*opening,(x+21.6)*.44,(1101.6-x)*.44);
    const limitY=Math.min(64+12*opening,(y+38.4)*.44,(1958.4-y)*.44);
    dx=clamp(dx,-Math.max(0,limitX),Math.max(0,limitX));dy=clamp(dy,-Math.max(0,limitY),Math.max(0,limitY));
    const magnitude=Math.hypot(dx,dy);maxDisplacement=Math.max(maxDisplacement,magnitude);
    if(x>=100&&x<=900&&y>=260&&y<=1550)maxBodyDisplacement=Math.max(maxBodyDisplacement,magnitude);
    vertices.push({sourceX,sourceY,x,y,dx,dy,tx:x+dx,ty:y+dy,weight,boundary});
  }
  const controls=[];
  for(let k=0;k<4;k++){
    const yy=-160+k*610,ph=phase+k*.94,base=1015+18*Math.sin(ph*.7),bend=(v===1?105:76)*Math.sin(ph);
    controls.push({x0:base+38,y0:yy,x1:base-110+bend,y1:yy+180,x2:base+125-bend*.58,y2:yy+380,x3:base-9+32*Math.sin(ph+.8),y3:yy+670,width:42+28*Math.sin(ph*.64+k)**2,phase:ph});
  }
  const hero={type:['unfurling-leaf','liquid-foil-loop','growing-root-network','engraved-wave-fold','torn-paper-curl','carmine-petal-veil'][fi],progress:ease(t/1.9),alpha:smooth(t/.5),twist:t*(v===1?.84:.63)+v*1.7,bounds:{left:150,top:1740,right:1100,bottom:1980},spine:heroSpine(t,v)};
  return {time:t,variant:v,family:scene.family||scene.id,signature:`${scene.family||scene.id}/${['travelling-growth','counter-torsion','fold-interference'][v]}`,grid:{columns:NX,rows:NY,triangles:NX*NY*2},fixedScale:OVERSCAN,rotation:0,amplitude,opening,vertices,controls,hero,maxDisplacement,maxBodyDisplacement,readingRegion:{left:100,top:260,right:900,bottom:1550}};
}

function triangle(ctx,image,s0,s1,s2,d0,d1,d2){
  // The same source-to-target affine map is used for every pixel of a triangle.
  const den=(s1.sourceX-s0.sourceX)*(s2.sourceY-s0.sourceY)-(s2.sourceX-s0.sourceX)*(s1.sourceY-s0.sourceY);
  const a=((d1.tx-d0.tx)*(s2.sourceY-s0.sourceY)-(d2.tx-d0.tx)*(s1.sourceY-s0.sourceY))/den;
  const c=((d2.tx-d0.tx)*(s1.sourceX-s0.sourceX)-(d1.tx-d0.tx)*(s2.sourceX-s0.sourceX))/den;
  const b=((d1.ty-d0.ty)*(s2.sourceY-s0.sourceY)-(d2.ty-d0.ty)*(s1.sourceY-s0.sourceY))/den;
  const d=((d2.ty-d0.ty)*(s1.sourceX-s0.sourceX)-(d1.ty-d0.ty)*(s2.sourceX-s0.sourceX))/den;
  const e=d0.tx-a*s0.sourceX-c*s0.sourceY,f=d0.ty-b*s0.sourceX-d*s0.sourceY;
  const cx=(d0.tx+d1.tx+d2.tx)/3,cy=(d0.ty+d1.ty+d2.ty)/3;
  const expanded=[d0,d1,d2].map(p=>{const l=Math.hypot(p.tx-cx,p.ty-cy)||1;return {x:p.tx+(p.tx-cx)*.75/l,y:p.ty+(p.ty-cy)*.75/l};});
  const left=Math.max(0,Math.min(s0.sourceX,s1.sourceX,s2.sourceX)-2),top=Math.max(0,Math.min(s0.sourceY,s1.sourceY,s2.sourceY)-2),right=Math.min(W,Math.max(s0.sourceX,s1.sourceX,s2.sourceX)+2),bottom=Math.min(H,Math.max(s0.sourceY,s1.sourceY,s2.sourceY)+2);
  ctx.save();ctx.beginPath();ctx.moveTo(expanded[0].x,expanded[0].y);ctx.lineTo(expanded[1].x,expanded[1].y);ctx.lineTo(expanded[2].x,expanded[2].y);ctx.closePath();ctx.clip();ctx.transform(a,b,c,d,e,f);ctx.drawImage(image,left,top,right-left,bottom-top,left,top,right-left,bottom-top);ctx.restore();
}

function mesh(ctx,image,state){
  const vs=state.vertices;
  // Base image under the expanded mesh is an insurance against antialias seams.
  ctx.drawImage(image,-21.6,-38.4,1123.2,1996.8);
  for(let j=0;j<NY;j++)for(let i=0;i<NX;i++){
    const a=vs[j*(NX+1)+i],b=vs[j*(NX+1)+i+1],c=vs[(j+1)*(NX+1)+i],d=vs[(j+1)*(NX+1)+i+1];
    if((i+j)%2){triangle(ctx,image,a,b,c,a,b,c);triangle(ctx,image,b,d,c,b,d,c);}
    else{triangle(ctx,image,a,b,d,a,b,d);triangle(ctx,image,a,d,c,a,d,c);}
  }
}

function drawPath(ctx,Path,path,fill,stroke,width=1,alpha=1){
  ctx.save();ctx.globalAlpha*=alpha;const p=new Path(path);if(fill){ctx.fillStyle=fill;ctx.fill(p);}if(stroke){ctx.strokeStyle=stroke;ctx.lineWidth=width;ctx.lineCap='round';ctx.lineJoin='round';ctx.stroke(p);}ctx.restore();
}
function curvePath(c){return `M${c.x0} ${c.y0} C${c.x1} ${c.y1} ${c.x2} ${c.y2} ${c.x3} ${c.y3}`;}
function cubicPoint(c,u){const q=1-u;return {x:q*q*q*c.x0+3*q*q*u*c.x1+3*q*u*u*c.x2+u*u*u*c.x3,y:q*q*q*c.y0+3*q*q*u*c.y1+3*q*u*u*c.y2+u*u*u*c.y3};}
function bandPath(c,width,twist){
  const a=width*(.4+.6*Math.abs(Math.cos(twist))),b=width*(.24+.76*Math.abs(Math.sin(twist+.7)));
  return `M${c.x0-a} ${c.y0} C${c.x1-b} ${c.y1} ${c.x2+a} ${c.y2} ${c.x3-b} ${c.y3} L${c.x3+b} ${c.y3} C${c.x2-a} ${c.y2} ${c.x1+b} ${c.y1} ${c.x0+a} ${c.y0}Z`;
}
function reveal(ctx,Path,path,p){
  if(p>=1)return;ctx.lineWidth=1;ctx.setLineDash([Math.max(1,p*2300),2600]);ctx.lineDashOffset=0;
}

function botanical(ctx,Path,a,state){
  const t=state.time,v=state.variant,growth=.48+.52*ease(t/2),ink=a.ink;
  for(let k=0;k<3;k++){
    const c=state.controls[k],curve=curvePath(c);
    ctx.save();ctx.globalAlpha=.44;ctx.strokeStyle=ink;ctx.lineWidth=3.3;ctx.lineCap='round';reveal(ctx,Path,curve,growth);ctx.stroke(new Path(curve));ctx.restore();
    for(let n=0;n<5;n++){
      const u=(n+.5)/5,p=cubicPoint(c,u),phase=t*.63+k*.7+n*.9,side=n%2?1:-1;
      const size=(45+24*Math.sin(phase*.6+v)**2)*growth,angle=side*(.6+.3*Math.sin(phase));
      ctx.save();ctx.translate(p.x,p.y);ctx.rotate(angle+(v===1?.4*Math.sin(phase):0));
      const d=`M0 0 C${-size*.8} ${-size*.32} ${-size*.9} ${-size*1.7} 0 ${-size*2.35} C${size*.68} ${-size*1.5} ${size*.63} ${-size*.4} 0 0Z`;
      drawPath(ctx,Path,d,color(ink,.19),ink,1.5,.7);drawPath(ctx,Path,`M0 0 Q${Math.sin(phase)*12} ${-size*1.1} 0 ${-size*2.2}`,null,ink,1,.42);ctx.restore();
    }
  }
  // A broad vine grows across the quiet top margin and curls at the edge.
  for(let k=0;k<7;k++){
    const x=135+k*154,y=70+34*Math.sin(t*.51+k*.87+v),s=(30+9*Math.sin(t*.4+k))*growth;
    ctx.save();ctx.translate(x,y);ctx.rotate(Math.sin(t*.38+k)*.4+v*.24);
    drawPath(ctx,Path,`M0 0 C${-s} ${-s*.2} ${-s*1.7} ${-s*1.1} ${-s*.7} ${-s*1.9} C${s*.85} ${-s*1.4} ${s*.5} ${-s*.2} 0 0Z`,color(ink,.21),ink,1.3,.68);ctx.restore();
  }
}

function chrome(ctx,Path,a,state){
  const t=state.time,v=state.variant;
  for(let k=0;k<4;k++){
    const c=state.controls[k],width=c.width*(v===1?1.25:v===2?.85:1),twist=t*.9+k*1.3+v;
    const g=ctx.createLinearGradient(890,0,1130,0),shift=.05*Math.sin(t*.81+k);
    g.addColorStop(0,a.dark);g.addColorStop(.25+shift,a.paper);g.addColorStop(.39+shift,a.dark);g.addColorStop(.57,a.paper);g.addColorStop(.67,a.ink);g.addColorStop(.8,a.paper);g.addColorStop(1,a.dark);
    drawPath(ctx,Path,bandPath(c,width,twist),g,a.paper,1.2,.84);
    const p=cubicPoint(c,.54+.17*Math.sin(t*.54+k));ctx.save();ctx.globalAlpha=.35;ctx.strokeStyle=a.paper;ctx.lineWidth=4;ctx.beginPath();ctx.ellipse(p.x,p.y,18+18*Math.sin(t+k)**2,45,Math.sin(t*.5+k),0,TAU);ctx.stroke();ctx.restore();
  }
  const top={x0:-130,y0:135,x1:240,y1:-130+Math.sin(t*.65)*95,x2:580,y2:160+Math.cos(t*.58)*70,x3:1200,y3:20};
  const g=ctx.createLinearGradient(0,0,0,180);g.addColorStop(0,a.dark);g.addColorStop(.4,a.paper);g.addColorStop(.57,a.dark);g.addColorStop(.8,a.paper);g.addColorStop(1,a.dark);
  drawPath(ctx,Path,bandPath(top,24+16*Math.sin(t*.7+v)**2,t*.6+v),g,null,1,.68);
}

function roots(ctx,Path,a,state){
  const t=state.time,v=state.variant,opening=ease(t/2.2);
  for(let k=0;k<5;k++){
    const original=state.controls[k%4],c={...original,x0:original.x0+k*6,x3:original.x3-k*7},phase=t*.53+k+v;
    const pth=curvePath(c);ctx.save();ctx.strokeStyle=k%2?a.paper:a.accent;ctx.lineWidth=k%2?7:12;ctx.globalAlpha=.6;ctx.lineCap='round';reveal(ctx,Path,pth,.45+.55*opening);ctx.stroke(new Path(pth));ctx.restore();
    for(let n=0;n<6;n++){
      const p=cubicPoint(c,(n+.4)/6),reach=30+38*Math.sin(phase+n*.6)**2,yy=p.y-90+40*Math.cos(phase+n),left=p.x-reach;
      const d=v===1?`M${p.x} ${p.y} C${left-20} ${p.y-12} ${p.x+38} ${yy-55} ${left} ${yy-100}`:`M${p.x} ${p.y} C${left-38} ${p.y-45} ${left+65} ${yy-35} ${left} ${yy-100}`;
      drawPath(ctx,Path,d,null,n%2?a.paper:a.accent,n%2?2.7:4.7,.54*opening);
      drawPath(ctx,Path,`M${left} ${yy-100} Q${left-50} ${yy-102} ${left-44} ${yy-153}`,null,a.paper,1.2,.44*opening);
    }
  }
  for(let k=0;k<5;k++){
    const yy=1695+k*49,bend=25*Math.sin(t*.65+k+v);
    drawPath(ctx,Path,`M-70 ${yy+80} C240 ${yy-80+bend} 550 ${yy+110-bend} 1140 ${yy-15}`,null,k%2?a.paper:a.accent,k%2?4:7,.38);
  }
}

function etching(ctx,Path,a,state){
  const t=state.time,v=state.variant;
  for(let n=0;n<18;n++){
    const wave=55*Math.sin(t*.65+n*.12+v),x=884+n*14;
    const d=v===1?`M${x+50} -80 C${x-80+wave} 300 ${x+170-wave} 710 ${x-45} 1030 C${x-90} 1310 ${x+130+wave} 1580 ${x} 2010`:`M${x} -80 C${x-90+wave} 440 ${x+140-wave} 700 ${x-20} 990 S${x+110+wave} 1590 ${x+10} 2010`;
    drawPath(ctx,Path,d,null,n%5?a.paper:a.accent,n%5?2.1:4,.38);
  }
  for(let n=0;n<12;n++){
    const yy=1655+n*24,wave=34*Math.sin(t*.72+n*.1+v);
    drawPath(ctx,Path,`M-90 ${yy} C230 ${yy-125+wave} 610 ${yy+115-wave} 1180 ${yy-40}`,null,n%3?a.paper:a.accent,n%3?1.7:3.5,.42);
  }
  for(let n=0;n<7;n++){
    const y=40+n*18,b=25*Math.sin(t*.67+n*.19+v);
    drawPath(ctx,Path,`M-90 ${y} C210 ${y-90+b} 530 ${y+90-b} 1170 ${y-45}`,null,a.paper,1.8,.27);
  }
}

function fanzine(ctx,Path,a,state){
  const t=state.time,v=state.variant;
  for(let k=0;k<6;k++){
    const y=-190+k*400,phase=t*.77+k*.8+v,bend=42*Math.sin(phase),x=995+19*Math.cos(phase*.8);
    const d=`M${x} ${y} L1110 ${y-50} L1140 ${y+400} L${x+12} ${y+430} Q${x-85+bend} ${y+290} ${x-17} ${y+210} Q${x+55-bend} ${y+125} ${x} ${y}Z`;
    drawPath(ctx,Path,d,k%2?a.paper:a.accent,a.ink,1.5,.53);
    const edge=`M${x} ${y} Q${x+55-bend} ${y+125} ${x-17} ${y+210} Q${x-85+bend} ${y+290} ${x+12} ${y+430}`;
    ctx.save();ctx.setLineDash([12,7,4,5]);ctx.lineDashOffset=-t*(v===2?38:19);drawPath(ctx,Path,edge,null,a.ink,6,.65);ctx.restore();
    for(let n=0;n<5;n++){const yy=y+70+n*58;drawPath(ctx,Path,`M${x-17+11*Math.sin(phase+n)} ${yy} L1120 ${yy-20}`,null,a.ink,n%2?3:9,.3);}
  }
  const bend=28*Math.sin(t*.75+v);
  drawPath(ctx,Path,`M-60 1665 Q320 ${1640+bend} 620 1735 Q850 ${1810-bend} 1150 1740 L1150 1830 Q680 ${1900+bend} -60 1765Z`,a.accent,a.ink,2,.6);
  for(let n=0;n<5;n++){const y=1700+n*22;drawPath(ctx,Path,`M-60 ${y} Q380 ${y-90+bend} 1100 ${y+80}`,null,a.ink,2,.55);}
}

function carmine(ctx,Path,a,state){
  const t=state.time,v=state.variant;
  for(let k=0;k<4;k++){
    const c=state.controls[k],twist=t*.7+k*.9+v;
    const gradient=ctx.createLinearGradient(860,0,1135,0);gradient.addColorStop(0,color(a.accent,.04));gradient.addColorStop(.3,a.accent);gradient.addColorStop(.53,a.paper);gradient.addColorStop(.63,a.dark);gradient.addColorStop(1,a.accent);
    drawPath(ctx,Path,bandPath(c,c.width*1.25,twist),gradient,a.paper,1,.48);
    for(let n=0;n<4;n++){
      const p=cubicPoint(c,(n+.3)/4),size=30+25*Math.sin(t*.5+k+n+v)**2;
      const d=`M${p.x} ${p.y} C${p.x-90-size} ${p.y-60} ${p.x-65} ${p.y-165-size} ${p.x+15} ${p.y-110} C${p.x+50} ${p.y-70} ${p.x+40} ${p.y-25} ${p.x} ${p.y}Z`;
      drawPath(ctx,Path,d,color(a.accent,.3),a.paper,1.3,.42);
    }
  }
  const wave=45*Math.sin(t*.62+v),c={x0:-150,y0:1785,x1:240,y1:1600+wave,x2:760,y2:1970-wave,x3:1200,y3:1730};
  const g=ctx.createLinearGradient(0,1620,0,1910);g.addColorStop(0,a.dark);g.addColorStop(.5,a.accent);g.addColorStop(.7,a.paper);g.addColorStop(1,a.dark);
  drawPath(ctx,Path,bandPath(c,31+16*Math.sin(t*.6+v)**2,t*.6),g,null,1,.47);
}

const drawVectors=[botanical,chrome,roots,etching,fanzine,carmine];

function smoothOutline(points,close=true){
  if(!points.length)return '';
  let d=`M${points[0].x} ${points[0].y}`;
  for(let i=0;i<points.length-1;i++){
    const p0=points[Math.max(0,i-1)],p1=points[i],p2=points[i+1],p3=points[Math.min(points.length-1,i+2)];
    d+=`C${p1.x+(p2.x-p0.x)/6} ${p1.y+(p2.y-p0.y)/6} ${p2.x-(p3.x-p1.x)/6} ${p2.y-(p3.y-p1.y)/6} ${p2.x} ${p2.y}`;
  }
  return d+(close?'Z':'');
}

// A broad two-turn material loop, with a continuously varying physical width.
// Its end grows along the curve; its cross section then turns over in place.
function heroSpine(t,v){
  const ph=t*.61+v*1.7;
  const one={x0:445+25*Math.sin(ph*.7),y0:1970,x1:365,y1:1805+18*Math.sin(ph),x2:705,y2:1750+15*Math.cos(ph*.9),x3:850+25*Math.sin(ph*.8),y3:1818+12*Math.sin(ph)};
  const two={x0:one.x3,y0:one.y3,x1:1035,y1:1910-25*Math.cos(ph),x2:655,y2:1970+18*Math.sin(ph*.8),x3:705+37*Math.cos(ph*.7),y3:1802+19*Math.sin(ph*.8)};
  return [one,two];
}
function heroRibbon(state,width=63){
  const v=state.variant,p=state.hero.progress,[one,two]=state.hero.spine;
  const points=[];
  for(let k=0;k<=64;k++){
    const u=k/64*p,q=u<.5?u*2:(u-.5)*2,c=u<.5?one:two,pt=cubicPoint(c,q),epsilon=.002,prev=cubicPoint(c,Math.max(0,q-epsilon)),next=cubicPoint(c,Math.min(1,q+epsilon));
    const length=Math.hypot(next.x-prev.x,next.y-prev.y)||1;
    const turn=.24+.76*Math.abs(Math.sin(state.hero.twist-u*(v===1?6.5:4.7)));
    const taper=Math.min(1,Math.sin(clamp(k/64/.11)*PI/2))*Math.min(1,Math.sin(clamp((1-k/64)/.12)*PI/2));
    points.push({...pt,nx:-(next.y-prev.y)/length,ny:(next.x-prev.x)/length,width:width*turn*(.17+.83*taper)*(.45+.55*p)});
  }
  const edgeA=points.map(q=>({x:q.x+q.nx*q.width,y:q.y+q.ny*q.width})),edgeB=points.map(q=>({x:q.x-q.nx*q.width,y:q.y-q.ny*q.width})).reverse();
  return {path:smoothOutline([...edgeA,...edgeB]),points,edgeA,edgeB};
}

function materialHero(ctx,Path,a,state){
  const fi=getMaterialArchetype(state),t=state.time,p=state.hero.progress,ph=state.hero.twist;
  if(p<=0)return;
  ctx.save();ctx.beginPath();ctx.rect(0,1740,1080,180);ctx.clip();ctx.globalAlpha*=smooth(t/.5);
  if(fi===0){
    // Three different leaves unfurl from a single bent stem, never paired ears.
    const stem=`M460 2010 C570 ${1860+20*Math.sin(ph)} 850 ${1970-25*Math.sin(ph)} 1060 1800`;
    ctx.save();ctx.strokeStyle=a.ink;ctx.lineWidth=6;ctx.globalAlpha=.78;reveal(ctx,Path,stem,p);ctx.stroke(new Path(stem));ctx.restore();
    for(let k=0;k<3;k++){
      const x=[560,745,920][k]+22*Math.sin(ph*.7+k),y=[1980,1940,1970][k],angle=[-.85,.45,-.2][k]+.22*Math.sin(ph+k),size=[130,92,115][k]*p;
      ctx.save();ctx.translate(x,y);ctx.rotate(angle);
      const leaf=`M0 0 C${-size*1.1} ${-size*.34} ${-size*1.35} ${-size*1.1} ${-size*.1} ${-size*1.62} C${size*.94} ${-size*1.1} ${size*.6} ${-size*.2} 0 0Z`;
      const g=ctx.createLinearGradient(-size,0,size,-size*1.6);g.addColorStop(0,a.ink);g.addColorStop(.5,color(a.ink,.84));g.addColorStop(1,a.paper);
      drawPath(ctx,Path,leaf,g,a.ink,2.2,.85);drawPath(ctx,Path,`M0 0 Q${Math.sin(ph+k)*18} ${-size*.78} ${-size*.1} ${-size*1.55}`,null,a.paper,2,.61);
      for(let n=1;n<5;n++){const yy=-size*n*.25;drawPath(ctx,Path,`M0 ${yy} Q${-size*.25} ${yy-size*.21} ${-size*.62} ${yy-size*.15}`,null,a.paper,1,.34);}
      ctx.restore();
    }
  }else if(fi===1){
    const r=heroRibbon(state,76),g=ctx.createLinearGradient(0,1740+22*Math.sin(ph),0,1960);
    g.addColorStop(0,a.dark);g.addColorStop(.17,'#959ca8');g.addColorStop(.29,a.paper);g.addColorStop(.37,a.dark);g.addColorStop(.51,a.paper);g.addColorStop(.58,'#7c8591');g.addColorStop(.74,a.dark);g.addColorStop(.86,a.paper);g.addColorStop(1,a.dark);
    ctx.save();ctx.shadowColor=color(a.dark,.45);ctx.shadowBlur=9;ctx.shadowOffsetY=7;drawPath(ctx,Path,r.path,g,a.paper,1.6,.97);ctx.restore();
    drawPath(ctx,Path,smoothOutline(r.edgeA,false),null,a.paper,2.7,.85);
    const glint=r.points[Math.floor((.28+.16*Math.sin(t*.7))*64)];drawPath(ctx,Path,`M${glint.x-glint.nx*glint.width*.75} ${glint.y-glint.ny*glint.width*.75} L${glint.x+glint.nx*glint.width*.75} ${glint.y+glint.ny*glint.width*.75}`,null,a.paper,3,.58);
  }else if(fi===2){
    for(let k=0;k<4;k++){
      const bend=31*Math.sin(ph+k*.64),c={x0:710+k*13,y0:1990,x1:625+bend,y1:1910,x2:320+k*205-bend,y2:1840,x3:340+k*220,y3:1773+20*Math.sin(ph+k)};
      const d=curvePath(c);ctx.save();ctx.strokeStyle=k%2?a.paper:a.accent;ctx.lineWidth=k===0?14:k===1?10:6;ctx.globalAlpha=.87;ctx.lineCap='round';reveal(ctx,Path,d,p);ctx.stroke(new Path(d));ctx.restore();
      for(let n=1;n<8;n++){
        if(n/8>p+.07)continue;
        const pt=cubicPoint(c,n/8),reach=35+45*Math.sin(ph*.7+n*.44+k)**2,dir=n%2?1:-1,tip=Math.max(1748,pt.y-reach-30),dx=55+30*Math.cos(ph+n);
        const branch=`M${pt.x} ${pt.y} C${pt.x-dx} ${pt.y-10} ${pt.x+dx*dir} ${tip-10} ${pt.x+dx*dir*.8} ${tip}`;
        drawPath(ctx,Path,branch,null,a.paper,n%3?3:5.5,.8);drawPath(ctx,Path,`M${pt.x+dx*dir*.8} ${tip} Q${pt.x+dx*dir*.4} ${tip-18} ${pt.x+dx*dir*.8-35} ${Math.max(1745,tip-35)}`,null,a.accent,2,.8);
      }
    }
  }else if(fi===3){
    const r=heroRibbon(state,80);
    drawPath(ctx,Path,r.path,a.dark,a.paper,1.7,.94);
    for(let n=0;n<11;n++){
      const d=smoothOutline(r.points.map(q=>({x:q.x+q.nx*q.width*(n/5-1),y:q.y+q.ny*q.width*(n/5-1)})),false);
      drawPath(ctx,Path,d,null,n%4?a.paper:a.accent,n%4?2:3.5,.73);
    }
    for(let n=5;n<62;n+=4){const q=r.points[n];drawPath(ctx,Path,`M${q.x-q.nx*q.width} ${q.y-q.ny*q.width} L${q.x+q.nx*q.width} ${q.y+q.ny*q.width}`,null,a.paper,1.1,.42);}
  }else if(fi===4){
    const r=heroRibbon(state,79),g=ctx.createLinearGradient(0,1760,0,1960);g.addColorStop(0,a.paper);g.addColorStop(.47,a.paper);g.addColorStop(.51,a.accent);g.addColorStop(.7,a.accent);g.addColorStop(1,a.ink);
    drawPath(ctx,Path,r.path,g,a.ink,2.5,.95);
    ctx.save();ctx.clip(new Path(r.path));
    for(let n=0;n<9;n++){const yy=1748+n*24+13*Math.sin(ph+n*.3);drawPath(ctx,Path,`M145 ${yy} C390 ${yy-44} 800 ${yy+55} 1110 ${yy-12}`,null,a.ink,n%3===0?9:2.5,.65);}
    ctx.restore();ctx.save();ctx.setLineDash([8,4,2,5]);ctx.lineDashOffset=-t*12;drawPath(ctx,Path,smoothOutline(r.edgeA,false),null,a.ink,5,.9);ctx.restore();
  }else{
    const r=heroRibbon(state,87),g=ctx.createLinearGradient(0,1740,0,1970);
    g.addColorStop(0,a.paper);g.addColorStop(.19,a.accent);g.addColorStop(.4,a.dark);g.addColorStop(.55,a.accent);g.addColorStop(.69,a.paper);g.addColorStop(.82,a.accent);g.addColorStop(1,a.dark);
    drawPath(ctx,Path,r.path,g,a.paper,1.5,.79);
    for(let n=0;n<5;n++){const d=smoothOutline(r.points.map(q=>({x:q.x+q.nx*q.width*(n/3-.7),y:q.y+q.ny*q.width*(n/3-.7)})),false);drawPath(ctx,Path,d,null,n%2?a.paper:a.accent,n%2?1.3:2.1,.46);}
  }
  ctx.restore();
}

/** Draw ONLY living background material, never native text or time frames. */
export function drawMaterialBackground(ctx,scene,assets,time,variant=0){
  const state=getMaterialState(scene,time,variant),Path=assets.Path2D;
  ctx.save();ctx.fillStyle=scene.theme.bg;ctx.fillRect(0,0,W,H);ctx.imageSmoothingEnabled=true;
  mesh(ctx,assets.background,state);
  drawVectors[familyOf(scene)](ctx,Path,scene.theme,state);
  materialHero(ctx,Path,scene.theme,state);
  // One broken material crease. It never resolves into an obvious bunny.
  const yy=1580+25*Math.sin(state.time*.23+state.variant);
  drawPath(ctx,Path,`M1064 ${yy} C1041 ${yy-15} 1049 ${yy-80} 1060 ${yy-89} C1073 ${yy-94} 1070 ${yy-50} 1065 ${yy-38}`,null,scene.theme.ink,1.5,.035);
  ctx.restore();return state;
}
