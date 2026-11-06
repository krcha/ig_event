import sharp from "sharp";
import { DEFAULT_MAX_IMAGE_BYTES } from "@/lib/images/image-response-guardrails";
import type { PublicEventRaster } from "@/lib/images/public-event-raster";
import { RESPONSIVE_IMAGE_WIDTHS, type ResponsiveImageFormat, type ResponsiveImageWidth } from "@/lib/images/responsive-image-url";

export const RESPONSIVE_IMAGE_RENDER_VERSION = "event-poster-v1";
export const MAX_RESPONSIVE_IMAGE_PIXELS = 20_000_000;
const MAX_IMAGE_DIMENSION = 16_384;
const MAX_ACTIVE_RENDERS = 2;
const MAX_WAITING_RENDERS = 16;
let activeRenders = 0;
const waiting: Array<() => void> = [];

export class OriginalRasterRequired extends Error {
  readonly raster: PublicEventRaster;
  constructor(raster: PublicEventRaster) {
    super("This raster should be served without transforming it.");
    this.raster = raster;
  }
}

function rasterKind(bytes: Buffer): "jpeg" | "png" | "webp" | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "png";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "webp";
  return null;
}

function isAnimated(bytes: Buffer, kind: "jpeg" | "png" | "webp"): boolean {
  if (kind === "png") {
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = bytes.readUInt32BE(offset);
      if (bytes.toString("ascii", offset + 4, offset + 8) === "acTL") return true;
      if (length > bytes.length - offset - 12) break;
      offset += length + 12;
    }
  }
  if (kind === "webp") {
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const name = bytes.toString("ascii", offset, offset + 4);
      const length = bytes.readUInt32LE(offset + 4);
      if (name === "ANIM" || name === "ANMF" || (name === "VP8X" && length > 0 && (bytes[offset + 8] & 2) !== 0)) return true;
      if (length > bytes.length - offset - 8) break;
      offset += length + 8 + (length % 2);
    }
  }
  return false;
}

async function withRenderSlot<T>(render: () => Promise<T>): Promise<T> {
  if (activeRenders >= MAX_ACTIVE_RENDERS) {
    if (waiting.length >= MAX_WAITING_RENDERS) throw new Error("Image renderer is busy.");
    await new Promise<void>((resolve) => waiting.push(resolve));
  } else activeRenders += 1;
  try { return await render(); }
  finally {
    const next = waiting.shift();
    if (next) next();
    else activeRenders -= 1;
  }
}

export async function renderResponsiveImage(
  raster: PublicEventRaster,
  width: ResponsiveImageWidth,
  format: ResponsiveImageFormat,
): Promise<Buffer> {
  if (!RESPONSIVE_IMAGE_WIDTHS.includes(width) || !["jpeg", "webp"].includes(format)) throw new Error("Invalid image variant.");
  if (!raster.bytes.length || raster.bytes.length > DEFAULT_MAX_IMAGE_BYTES) throw new Error("Invalid image byte length.");
  // Validate magic before giving any bytes to a native decoder. Other existing
  // raster formats and animated media retain their original endpoint behavior.
  const kind = rasterKind(raster.bytes);
  if (!kind) {
    if (["image/avif", "image/gif", "image/heic", "image/heif"].includes(raster.contentType)) throw new OriginalRasterRequired(raster);
    throw new Error("Invalid raster signature.");
  }
  if (!(raster.contentType === `image/${kind}` || (kind === "jpeg" && raster.contentType === "image/jpg"))) throw new Error("Raster signature and MIME type differ.");
  if (isAnimated(raster.bytes, kind)) throw new OriginalRasterRequired(raster);

  return withRenderSlot(async () => {
    const input = sharp(raster.bytes, { limitInputPixels: MAX_RESPONSIVE_IMAGE_PIXELS, sequentialRead: true, failOn: "error" });
    const metadata = await input.metadata();
    if (!metadata.width || !metadata.height || metadata.width > MAX_IMAGE_DIMENSION || metadata.height > MAX_IMAGE_DIMENSION || metadata.width * metadata.height > MAX_RESPONSIVE_IMAGE_PIXELS) throw new Error("Image dimensions exceed safe limits.");
    if ((metadata.pages ?? 1) > 1) throw new OriginalRasterRequired(raster);
    const resized = input.rotate().resize({ width, withoutEnlargement: true, fit: "inside" }).timeout({ seconds: 8 });
    const bytes = await (format === "webp"
      ? resized.webp({ quality: 82, effort: 3 })
      : resized.flatten({ background: "#ffffff" }).jpeg({ quality: 82, progressive: true, mozjpeg: false })).toBuffer();
    if (bytes.length > DEFAULT_MAX_IMAGE_BYTES) throw new Error("Image variant exceeds byte limit.");
    return bytes;
  });
}
