import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import path from "node:path";
import {reelVideoResponse} from "@/lib/social/reel-video";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const root = path.join(process.cwd(), "public", "social", "special", "2026-10-25");
const allowed = new Set(["post.jpg", "story.jpg", "reel-cover.jpg", "reel.mp4"]);
const failure = (status: number) => new Response(null, {status, headers: {"cache-control": "no-store", "x-content-type-options": "nosniff"}});

export async function GET(request: Request, context: {params: Promise<{asset: string}>}) {
  const {asset} = await context.params;
  if (!allowed.has(asset)) return failure(404);
  const query = new URL(request.url).searchParams;
  if (query.getAll("v").length !== 1 || !/^[a-f0-9]{64}$/.test(query.get("v") || "")) return failure(400);
  try {
    const bytes = await readFile(path.join(root, asset));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (query.get("v") !== sha256) return failure(409);
    const response = asset.endsWith(".mp4") ? reelVideoResponse(bytes, request) : new Response(request.method === "HEAD" ? null : new Uint8Array(bytes), {
      headers: {"content-type": "image/jpeg", "content-length": String(bytes.length)},
    });
    response.headers.set("cache-control", response.ok ? "public, max-age=31536000, immutable" : "no-store");
    response.headers.set("x-content-sha256", sha256);
    response.headers.set("x-content-type-options", "nosniff");
    return response;
  } catch { return failure(503); }
}

export const HEAD = GET;
