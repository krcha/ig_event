import { AgendaRenderError, getAgendaFonts, measureAgendaText, outlinedAgendaText, type AgendaLayoutRow } from "./agenda-layout.ts";

export { SOCIAL_DESIGN_VERSION } from "./poster-directions.ts";
export const AGENDA_TIME_FRAME = { x: 60, width: 168, height: 108, radius: 20, fontSize: 34, gap: 10 } as const;
export type AgendaFormat = "feed" | "story" | "reel";
export type AgendaBand = { base: string; text: string; motif: string };
const PATTERNS = ["orbits","curtains","echo","checker","scallops","spiral","stamps","seismic","honeycomb","dotfield","rays","weave","petals","terrazzo","steps","contours","tiles","triangles","cutpaper","zigzag","starfield"] as const;
const PALETTES=[
  {id:'01',name:'Limeta / koral / kobalt',paper:'#F5F0E4',ink:'#15241E',accent:'#3755D8',badge:'#F5F0E4',bands:[
    ['#D9EE8B','#15241E','orbits'],['#F8B0A2','#47221F','curtains'],['#3755D8','#FFF9EC','echo']]},
  {id:'02',name:'Mango / jorgovan / petrol',paper:'#183B3B',ink:'#FBF3DA',accent:'#FFC96F',badge:'#183B3B',bands:[
    ['#FFC96F','#34261A','checker'],['#C2B6EF','#292136','scallops'],['#00665F','#FFFAE7','spiral']]},
  {id:'03',name:'Menta / cinober / vanila',paper:'#FCF2E3',ink:'#292B25',accent:'#D44327',badge:'#FFF7E5',bands:[
    ['#A4E8E0','#193B3B','stamps'],['#E34A2A','#11110E','seismic'],['#F4E6AB','#3B3521','honeycomb']]},
  {id:'04',name:'Roze / citron / ponoć',paper:'#281D30',ink:'#FFF1DF',accent:'#D0DF55',badge:'#281D30',bands:[
    ['#E7AACB','#39243D','dotfield'],['#D0DF55','#29321B','rays'],['#24386B','#FFF3E4','weave']]},
  {id:'05',name:'Led / višnja / pesak',paper:'#F0F3F5',ink:'#24303F',accent:'#71344E',badge:'#F8F4EF',bands:[
    ['#ADCEF4','#21334C','petals'],['#71344E','#FFF5E9','terrazzo'],['#E3C396','#402E27','steps']]},
  {id:'06',name:'Žalfija / mandarina / šljiva',paper:'#302719',ink:'#FFF0D7',accent:'#FA8A51',badge:'#302719',bands:[
    ['#BBCDA4','#29372A','contours'],['#FA8A51','#3F261C','tiles'],['#603552','#FFF1E1','triangles']]},
  {id:'07',name:'Rđa / zaliv / pistać',paper:'#F2EADB',ink:'#303426',accent:'#B14B31',badge:'#FFF4E1',bands:[
    ['#B5452A','#FFF9EE','cutpaper'],['#9BC4D3','#233943','zigzag'],['#C7D5A0','#2C3927','starfield']]},
] as const;
// A fourth, complementary color is reserved for four-event Reels. Feed and
// Story palettes keep their existing three bands and exact render versions.
const REEL_FOURTH_BANDS = [
  ["#C6B9E9", "#30233F"], ["#F2A7BC", "#35212E"],
  ["#365B89", "#FFF5E8"], ["#A8D8D0", "#203B37"],
  ["#DCEB80", "#30361E"], ["#A9C9EB", "#21344C"],
  ["#D8A9C6", "#3F2940"],
] as const;
function luminance(hex: string){const rgb=[0,2,4].map(i=>parseInt(hex.slice(i,i+2),16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;}
function contrast(a: string,b: string){const x=luminance(a.slice(1)),y=luminance(b.slice(1));return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);}
export function agendaStar(cx: number,cy: number,r: number,inner: number,fill: string,points=12){return `<polygon points="${Array.from({length:points*2},(_,i)=>{const a=i*Math.PI/points-Math.PI/2,n=i%2?inner:r;return `${cx+Math.cos(a)*n},${cy+Math.sin(a)*n}`;}).join(' ')}" fill="${fill}"/>`;}
export function renderAgendaPattern(motif: string,row: Pick<AgendaLayoutRow, "top" | "height">,foreground: string,index: number,base: string){
  const text=contrast(base,foreground)<6.5?(luminance(foreground.slice(1))>luminance(base.slice(1))?'#000000':'#FFFFFF'):foreground;
  const y=row.top,h=row.height,center=y+h*.55;
  const stroke=`stroke="${text}" fill="none"`;
  const lines=Array.from({length:12},(_,i)=>i);
  let art='';
  switch(motif){
    case'orbits':art=`<g ${stroke}>${lines.map(i=>`<ellipse cx="1040" cy="${center}" rx="${65+i*16}" ry="${34+i*10}" transform="rotate(-28 1040 ${center})"/>`).join('')}</g>`;break;
    case'curtains':art=`<g stroke="${text}" fill="none" stroke-width="17">${lines.map(i=>`<path d="M${740+i*43} ${y-35}C${690+i*43} ${y+h*.27},${960+i*43} ${y+h*.62},${820+i*43} ${y+h+45}"/>`).join('')}</g>`;break;
    case'echo':art=`<g ${stroke}>${lines.map(i=>`<circle cx="1090" cy="${center}" r="${45+i*22}"/>`).join('')}</g>`;break;
    case'checker':art=`<g transform="translate(775 ${y-50}) rotate(13)" fill="${text}">${Array.from({length:72},(_,i)=>{const x=i%8,yy=Math.floor(i/8);return (x+yy)%2?`<rect x="${x*43}" y="${yy*43}" width="43" height="43"/>`:'';}).join('')}</g>`;break;
    case'scallops':art=`<g ${stroke}>${Array.from({length:30},(_,i)=>`<path d="M${750+i%6*72} ${y-40+Math.floor(i/6)*72}a36 36 0 1 0 72 0"/>`).join('')}</g>`;break;
    case'spiral':{let points=[];for(let i=0;i<420;i++){const a=i*.13,r=i*.7;points.push(`${1000+Math.cos(a)*r},${center+Math.sin(a)*r}`);}art=`<polyline points="${points.join(' ')}" ${stroke} stroke-width="5"/>`;break;}
    case'stamps':art=`<g transform="rotate(-12 1000 ${center})" ${stroke}>${Array.from({length:12},(_,i)=>`<rect x="${780+i%3*112}" y="${y-70+Math.floor(i/3)*112}" width="88" height="88" rx="6" stroke-dasharray="4 5"/><rect x="${789+i%3*112}" y="${y-61+Math.floor(i/3)*112}" width="70" height="70" rx="2"/>`).join('')}</g>`;break;
    case'seismic':art=`<g ${stroke}>${lines.map(i=>`<path d="M750 ${y+i*27-35}q45-55 85 0t85 0t85 0t85 0"/>`).join('')}</g>`;break;
    case'honeycomb':art=`<g ${stroke}>${Array.from({length:36},(_,i)=>{const x=780+(i%6)*60,yy=y-32+Math.floor(i/6)*69+(i%2)*34;return `<path d="M${x} ${yy-35}l30 17v35l-30 17-30-17v-35Z"/>`;}).join('')}</g>`;break;
    case'dotfield':art=`<g fill="${text}">${Array.from({length:110},(_,i)=>`<circle cx="${775+i%10*34}" cy="${y-20+Math.floor(i/10)*31}" r="${2+(i%10)*.8}"/>`).join('')}</g>`;break;
    case'rays':art=`<g fill="${text}">${Array.from({length:18},(_,i)=>`<path d="M1050 ${center}l390 -26v52Z" transform="rotate(${i*20} 1050 ${center})"/>`).join('')}</g>`;break;
    case'weave':art=`<g transform="rotate(-26 1040 ${center})" stroke="${text}" fill="none" stroke-width="9">${lines.map(i=>`<path d="M${740+i*39} ${y-170}v${h+340}"/><path d="M710 ${y-90+i*39}h650"/>`).join('')}</g>`;break;
    case'petals':art=`<g transform="translate(1005 ${center})" ${stroke}>${Array.from({length:16},(_,i)=>`<ellipse cx="66" cy="0" rx="100" ry="30" transform="rotate(${i*22.5})"/>`).join('')}</g>`;break;
    case'terrazzo':art=`<g fill="${text}">${Array.from({length:32},(_,i)=>{const x=800+i%5*65,yy=y-20+Math.floor(i/5)*54;return i%3===0?`<path d="M${x} ${yy}l29 7-12 28-23-12Z"/>`:i%3===1?`<path d="M${x} ${yy}a26 26 0 0 1 28 31Z"/>`:`<rect x="${x}" y="${yy}" width="12" height="31" rx="5" transform="rotate(${i*19} ${x} ${yy})"/>`;}).join('')}</g>`;break;
    case'steps':art=`<g ${stroke} stroke-width="3">${lines.map(i=>`<path d="M${775+i*27} ${y-45}v90h48v70h48v70h48v70h48v70"/>`).join('')}</g>`;break;
    case'contours':art=`<g ${stroke}>${lines.map(i=>`<path d="M${760+i*20} ${y-40}C${1075+i*20} ${y+10},${630+i*20} ${center},${900+i*20} ${y+h+35}"/>`).join('')}</g>`;break;
    case'tiles':art=`<g ${stroke}>${Array.from({length:30},(_,i)=>{const x=770+i%5*75,yy=y-40+Math.floor(i/5)*75;return `<rect x="${x}" y="${yy}" width="75" height="75"/><path d="M${x} ${yy+75}a75 75 0 0 0 75-75M${x} ${yy+38}a38 38 0 0 0 38-38"/>`;}).join('')}</g>`;break;
    case'triangles':art=`<g ${stroke}>${lines.map(i=>`<path d="M${1015} ${center-35-i*22}l${45+i*26} ${79+i*43}H${970-i*26}Z"/>`).join('')}</g>`;break;
    case'cutpaper':art=`<g fill="${text}"><path d="M820 ${y-30}h240l-70 90 120 66-125 80 94 100-238 17 67-86-110-64 115-91Z"/><circle cx="1010" cy="${center}" r="62" fill="black" fill-opacity=".22"/></g>`;break;
    case'zigzag':art=`<g ${stroke} stroke-width="7">${lines.map(i=>`<path d="M${750+i*36} ${y-45}l-30 53 30 53-30 53 30 53-30 53 30 53-30 53"/>`).join('')}</g>`;break;
    case'starfield':art=`<g fill="${text}">${Array.from({length:18},(_,i)=>agendaStar(805+i%4*86,y-25+Math.floor(i/4)*76,18+(i%3)*9,8+(i%3)*3,text,4)).join('')}</g>`;break;
    default:throw new Error('Unknown pattern.');
  }
  let opacity=['checker','rays','weave','cutpaper'].includes(motif)?.105:.16;
  const blend=(alpha: number)=>'#'+[0,1,2].map(i=>Math.round(parseInt(base.slice(1+i*2,3+i*2),16)*(1-alpha)+parseInt(text.slice(1+i*2,3+i*2),16)*alpha).toString(16).padStart(2,'0')).join('');
  while(contrast(blend(opacity),foreground)<4.5 && opacity>.02)opacity-=.01;
  if (contrast(blend(opacity),foreground)<4.5) throw new AgendaRenderError('Pattern cannot preserve text contrast.');
  return `<g class="event-pattern" data-pattern="${motif}" opacity="${opacity.toFixed(3)}" stroke-width="2.3" clip-path="url(#pattern-${index})">${art}</g>`;
}

function modulo(value: number, divisor: number): number { return ((value % divisor) + divisor) % divisor; }

export function getAgendaTheme(date: string, position = 0, format: AgendaFormat = "feed") {
  const ordinal = Math.floor(new Date(`${date}T12:00:00Z`).getTime() / 86_400_000);
  if (!Number.isFinite(ordinal)) throw new AgendaRenderError("Invalid artwork date.");
  const formatOffset = format === "story" ? 2 : format === "reel" ? 4 : 0;
  const variant = modulo(ordinal + position * 2 + formatOffset, PALETTES.length);
  const palette = PALETTES[variant];
  const bands: AgendaBand[] = (format === "reel" ? [0, 1, 2, 3] : [0, 1, 2]).map(index => {
    const band = index === 3 ? REEL_FOURTH_BANDS[variant] : palette.bands[modulo(index + Math.floor(ordinal / 7) + formatOffset, 3)];
    return { base: band[0], text: band[1], motif: PATTERNS[modulo(ordinal * 3 + position * 7 + formatOffset * 3 + index, PATTERNS.length)] };
  });
  return { ...palette, variant, bands };
}

export function renderAgendaTimeFrame(row: AgendaLayoutRow, text: string): string {
  const fonts = getAgendaFonts();
  const { x, width, height, radius, fontSize, gap } = AGENDA_TIME_FRAME;
  if (row.height < height + 28) throw new AgendaRenderError("Time frame cannot fit safely in its event panel.");
  const y = Math.max(row.top + 14, Math.min(row.bodyTop - 6, row.top + row.height - height - 14));
  const metrics = row.timeLines.map(line => measureAgendaText(fonts.time, line, fontSize));
  const contentHeight = metrics.reduce((sum, item) => sum + item.height, 0) + gap * (metrics.length - 1);
  if (contentHeight > height - 18 || metrics.some(item => item.width > width - 24)) throw new AgendaRenderError("Complete event time cannot fit the standard frame.");
  let top = y + (height - contentHeight) / 2;
  const glyphs = row.timeLines.map((line, index) => {
    const result = outlinedAgendaText(line, fonts.time, fontSize, x + (width - metrics[index].width) / 2, top, text);
    top += metrics[index].height + gap;
    return result;
  }).join("");
  return `<g class="time-label"><rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" fill="none" stroke="${text}" stroke-width="1.8"/>${glyphs}</g>`;
}
