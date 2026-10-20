import { createCanvas, loadImage, Path2D, type Image } from '@napi-rs/canvas';
import sharp from 'sharp';
import { background, buildPosterArtwork, buildPosterClosing, eventPanel, type PosterInput } from './poster-renderer.ts';
import { drawMaterialBackground } from './material-background.mjs';
import { resolvePosterPublicationDate } from './poster-directions.ts';

const darkPanels = new Set(['night','heat','tribal','redprint','laser','bio','signal']);
const body = (svg: string | Buffer) => String(svg).replace(/^[\s\S]*?<svg\b[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/<title>[\s\S]*?<\/title>/g, '').replace(/<desc>[\s\S]*?<\/desc>/g, '');
const wrap = (content: string, height = 1920) => `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="${height}">${content}</svg>`;
async function layer(content: string, height = 1920): Promise<Image> {
  return loadImage(await sharp(Buffer.from(wrap(content, height)), {limitInputPixels: 2_100_000}).png().toBuffer());
}

export function publicationDateFor(input: Pick<PosterInput,'date'|'format'|'position'|'publishDate'>): string {
  return resolvePosterPublicationDate(input.date,input.position,input.format || 'feed',input.publishDate);
}

// The exact native outlined text, time frames and image layers are prepared
// once per render. Only the material and panel hulls change on later frames.
export async function prepareDailyAgendaScene(input: PosterInput) {
  const publishDate = publicationDateFor(input), artwork = buildPosterArtwork({...input,publishDate});
  const baseBackground = background(artwork.theme,1920), base = body(artwork.baseSvg);
  if (!base.startsWith(baseBackground)) throw new Error('Native poster layer boundary changed.');
  const closing = buildPosterClosing(publishDate), closingBackground = background(closing.theme,1350), closingBody = body(closing.svg);
  if (closing.theme.id !== artwork.theme.id || !closingBody.startsWith(closingBackground)) throw new Error('Daily CTA must use the programme material.');
  const rows = artwork.rows.map((row,index) => {
    const left=Math.floor(row.x-10),top=Math.floor(row.top-10);
    return {...row,crop:{left,top,width:Math.ceil(row.x+row.width+10)-left,height:Math.ceil(row.top+row.height+10)-top},fill:artwork.theme.rowFills?.[index] || (darkPanels.has(artwork.theme.panel)?artwork.theme.dark:artwork.theme.colors[index]),accent:artwork.theme.colors[index]};
  });
  const rowAssets = await Promise.all(rows.map(async(row,index) => {
    const panel=eventPanel(artwork.theme,row,index), complete=body(artwork.rowSvgs[index]);
    if(!complete.startsWith(panel)) throw new Error('Native event panel layer boundary changed.');
    const crop=async(content:string)=>loadImage(await sharp(Buffer.from(wrap(content))).extract(row.crop).png().toBuffer());
    const [panelImage,contentImage]=await Promise.all([crop(panel),crop(complete.slice(panel.length))]);
    return {panel:panelImage,content:contentImage};
  }));
  const [backgroundImage,headerImage,ctaImage]=await Promise.all([
    layer(baseBackground),layer(base.slice(baseBackground.length)),
    layer(`<g transform="translate(10 290) scale(.92)">${closingBody.slice(closingBackground.length)}</g>`),
  ]);
  const scene={id:artwork.theme.id,family:artwork.theme.id,format:input.format || 'reel',width:1080,height:1920,theme:artwork.theme,panelDark:darkPanels.has(artwork.theme.panel),rows,bounds:artwork.bounds,publishDate};
  const assets={Path2D,background:backgroundImage,header:headerImage,cta:ctaImage,rows:rowAssets};
  return {scene,assets,variant:artwork.theme.motionVariant,artwork};
}

// Feed/CTA stills are frozen moments of the identical material engine. Native
// type is composited afterwards at its original size, never transformed.
export async function renderMaterialPosterStill(input: PosterInput): Promise<Buffer> {
  const publishDate=publicationDateFor(input),artwork=buildPosterArtwork({...input,publishDate});
  return materialStill(artwork.theme,body(artwork.svg),artwork.height,6+input.position*.6,(artwork.theme.motionVariant+input.position)%3);
}
export async function renderMaterialClosingStill(publishDate?: string): Promise<Buffer> {
  const closing=buildPosterClosing(publishDate);
  return materialStill(closing.theme,body(closing.svg),1350,7.8,closing.theme.motionVariant);
}
async function materialStill(theme: ReturnType<typeof buildPosterArtwork>['theme'],content:string,height:number,time:number,variant:number):Promise<Buffer>{
  const nativeBackground=background(theme,height);
  if(!content.startsWith(nativeBackground))throw new Error('Native still background boundary changed.');
  const raster=await sharp(Buffer.from(wrap(nativeBackground,height))).resize(1080,1920).png().toBuffer();
  const image=await loadImage(raster),canvas=createCanvas(1080,1920),ctx=canvas.getContext('2d');
  drawMaterialBackground(ctx,{id:theme.id,family:theme.id,theme},{Path2D,background:image},time,variant);
  const material=await sharp(canvas.encodeSync('png')).resize(1080,height).png().toBuffer();
  const overlay=await sharp(Buffer.from(wrap(content.slice(nativeBackground.length),height))).png().toBuffer();
  return sharp(material).composite([{input:overlay}]).jpeg({quality:93,chromaSubsampling:'4:4:4'}).toBuffer();
}
