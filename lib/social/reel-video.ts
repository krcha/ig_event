import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { drawFrame, DURATION, FPS } from "./material-motion.mjs";
import { prepareDailyAgendaScene, publicationDateFor, renderMaterialPosterStill } from "./material-scene.ts";
import { SOCIAL_DESIGN_VERSION } from "./poster-directions.ts";
import type { DailyCarouselEvent } from "./daily-carousel.ts";

let rendering = false;
const inFlight = new Map<string, Promise<Buffer>>();

export async function renderReelCover(date: string, events: DailyCarouselEvent[], publishDate?: string): Promise<Buffer> {
  return renderMaterialPosterStill({ date, events, position: 0, format: "reel", publishDate });
}

export type AgendaVideoOptions = {format: "story" | "reel"; publishDate?: string};
export function renderDailyReel(date: string, events: DailyCarouselEvent[], publishDate?: string): Promise<Buffer> {
  return renderDailyAgendaVideo(date,events,{format:"reel",publishDate});
}
export function renderDailyStory(date: string, events: DailyCarouselEvent[], publishDate?: string): Promise<Buffer> {
  return renderDailyAgendaVideo(date,events,{format:"story",publishDate});
}
export async function renderDailyAgendaVideo(date: string, events: DailyCarouselEvent[], options: AgendaVideoOptions): Promise<Buffer> {
  const publishDate=publicationDateFor({date,format:options.format,position:0,publishDate:options.publishDate});
  const key = createHash("sha256").update(JSON.stringify({format:options.format,date,publishDate,events,design:SOCIAL_DESIGN_VERSION,motion:"material-motion-v2",encoding:"raw-rgba-v1",duration:DURATION,fps:FPS})).digest("hex");
  const existing = inFlight.get(key);
  if (existing) return existing;
  const promise = (async () => {
    const cache = process.env.EVENTZEKA_REEL_CACHE_DIR || path.join(os.tmpdir(), "eventzeka-reels");
    await mkdir(cache, { recursive: true, mode: 0o700 });
    const target = path.join(cache, `${key}.mp4`);
    try { const bytes = await readFile(target); if (bytes.length > 1000) return bytes; } catch { /* First render. */ }
    if (rendering) throw new Error("Another agenda video is rendering. Retry shortly.");
    rendering = true;
    let temporary: string | undefined;
    try {
      temporary = await mkdtemp(path.join(cache, "render-"));
      const {scene,assets,variant}=await prepareDailyAgendaScene({date,events,position:0,format:options.format,publishDate});
      const canvas=createCanvas(1080,1920),context=canvas.getContext("2d"),output=path.join(temporary,"agenda.mp4");
      // Stream lossless RGBA snapshots with backpressure; avoid a JPEG encode/decode
      // round trip for every frame. No frame sequence is kept on disk.
      const args=["-hide_banner","-loglevel","error","-y","-f","rawvideo","-pixel_format","rgba","-video_size","1080x1920","-framerate",String(FPS),"-i","pipe:0","-f","lavfi","-i","anullsrc=r=48000:cl=stereo","-map","0:v","-map","1:a","-t",String(DURATION),
        "-vf","scale=in_range=pc:out_range=tv:in_color_matrix=bt601:out_color_matrix=bt709,format=yuv420p",
        "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-maxrate", "6M", "-bufsize", "12M", "-pix_fmt", "yuv420p", "-r", String(FPS), "-g", "60", "-threads", "2", "-movflags", "+faststart", "-use_editlist", "0","-color_range","tv","-colorspace","bt709","-color_trc","bt709","-color_primaries","bt709",output];
      const child=spawn(process.env.EVENTZEKA_FFMPEG_PATH || "ffmpeg",args,{stdio:["pipe","ignore","pipe"]});
      let errors="",timedOut=false;child.stderr.on("data",chunk=>{errors=(errors+String(chunk)).slice(-16_000);});
      const encoderError=(reason:string)=>new Error(timedOut ? "Agenda encoding exceeded 360 seconds." : errors || reason);
      const completed=new Promise<void>((resolve,reject)=>{
        child.once("error",error=>reject(encoderError(error.message)));
        child.stdin.on("error",error=>reject(encoderError(`Agenda encoder input failed: ${error.message}`)));
        child.once("close",(code,signal)=>code===0?resolve():reject(encoderError(`Agenda encoder exited with ${signal || code}.`)));
      });
      void completed.catch(()=>{});
      // Keep encoding below the 420-second media request and 600-second route limits.
      const timer=setTimeout(()=>{timedOut=true;child.kill("SIGKILL");},360_000);
      try {
        for(let frame=0;frame<DURATION*FPS;frame++){
          drawFrame(context,scene,assets,frame/FPS,variant);
          if(child.exitCode!==null || child.signalCode!==null)throw encoderError("Agenda encoder ended before all frames.");
          if(!child.stdin.write(canvas.data()))await Promise.race([once(child.stdin,"drain"),completed.then(()=>{throw encoderError("Agenda encoder ended before all frames.");})]);
        }
        child.stdin.end();await completed;
      } catch(error){child.kill("SIGKILL");await completed.catch(()=>{});throw encoderError(error instanceof Error ? error.message : "Agenda frame streaming failed.");} finally {clearTimeout(timer);}
      const size = (await stat(output)).size;
      if (size < 1000 || size > 100_000_000) throw new Error("Reel render has an invalid file size.");
      await rename(output, target);
      // Bound cached storage to seven days; no event data is stored in filenames.
      const { readdir } = await import("node:fs/promises");
      for (const filename of await readdir(cache)) {
        if (!/^[a-f0-9]{64}\.mp4$/.test(filename) || filename === `${key}.mp4`) continue;
        const old = path.join(cache, filename);
        if (Date.now() - (await stat(old)).mtimeMs > 7 * 86_400_000) await rm(old, { force: true });
      }
      return await readFile(target);
    } finally { try { if(temporary)await rm(temporary, { recursive: true, force: true }); } finally {rendering = false;} }
  })();
  inFlight.set(key, promise);
  try { return await promise; } finally { inFlight.delete(key); }
}

export function reelVideoResponse(bytes: Buffer, request: Request): Response {
  const headers = { "content-type": "video/mp4", "cache-control": "public, max-age=60, must-revalidate", "accept-ranges": "bytes", "x-content-type-options": "nosniff" };
  const range = request.headers.get("range");
  if (!range) return new Response(request.method === "HEAD" ? null : new Uint8Array(bytes), { headers: { ...headers, "content-length": String(bytes.length) } });
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  let start = match?.[1] ? Number(match[1]) : 0;
  let end = match?.[2] ? Number(match[2]) : bytes.length - 1;
  if (match && !match[1] && match[2]) { start = Math.max(0, bytes.length - Number(match[2])); end = bytes.length - 1; }
  end = Math.min(end, bytes.length - 1);
  if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= bytes.length) {
    return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${bytes.length}` } });
  }
  return new Response(request.method === "HEAD" ? null : new Uint8Array(bytes.subarray(start, end + 1)), {
    status: 206, headers: { ...headers, "content-range": `bytes ${start}-${end}/${bytes.length}`, "content-length": String(end - start + 1) },
  });
}
