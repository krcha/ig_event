export const RESPONSIVE_IMAGE_WIDTHS = [192, 384, 768, 1080, 1600] as const;
export type ResponsiveImageWidth = typeof RESPONSIVE_IMAGE_WIDTHS[number];
export type ResponsiveImageFormat = "jpeg" | "webp";

const EVENT_IMAGE_PATH = /^\/api\/discover\/images\/[^/?#]+$/;

// Only the existing event proxy can be transformed. Remote URLs remain under
// the server's source and public-eligibility checks, never in a transform URL.
export function getResponsiveEventImageUrl(
  src: string,
  width: ResponsiveImageWidth,
  version?: string | number,
): string | null {
  const [pathname, query] = src.split("?", 2);
  if (!EVENT_IMAGE_PATH.test(pathname)) return null;
  const params = new URLSearchParams(query);
  params.set("w", String(width));
  if (version !== undefined) params.set("v", String(version).slice(0, 128));
  return `${pathname}?${params.toString()}`;
}

export function getResponsiveEventImageSrcSet(src: string, version?: string | number): string | undefined {
  return RESPONSIVE_IMAGE_WIDTHS.map((width) => {
    const url = getResponsiveEventImageUrl(src, width, version);
    return url ? `${url} ${width}w` : null;
  }).filter(Boolean).join(", ") || undefined;
}

export function parseResponsiveImageRequest(request: Request): {
  width?: ResponsiveImageWidth;
  format: ResponsiveImageFormat;
} {
  const params = new URL(request.url).searchParams;
  for (const name of params.keys()) {
    if (!["w", "format", "v"].includes(name) || params.getAll(name).length !== 1) {
      throw new Error("Invalid image variant parameter.");
    }
  }
  const rawWidth = params.get("w");
  const width = rawWidth === null ? undefined : Number(rawWidth);
  if (width !== undefined && (!RESPONSIVE_IMAGE_WIDTHS.includes(width as ResponsiveImageWidth) || String(width) !== rawWidth)) {
    throw new Error("Unsupported image width.");
  }
  const rawFormat = params.get("format");
  if (rawFormat !== null && (width === undefined || !["jpeg", "webp"].includes(rawFormat))) {
    throw new Error("Unsupported image format.");
  }
  if ((params.get("v")?.length ?? 0) > 128) throw new Error("Invalid image version.");
  const supportsWebp = (request.headers.get("accept") ?? "").split(",").some((part) => {
    const [type, ...attributes] = part.trim().split(";");
    const quality = attributes.find((attribute) => attribute.trim().startsWith("q="));
    return type === "image/webp" && (quality === undefined || Number(quality.trim().slice(2)) > 0);
  });
  return {
    width: width as ResponsiveImageWidth | undefined,
    format: rawFormat === "jpeg" || rawFormat === "webp" ? rawFormat : supportsWebp ? "webp" : "jpeg",
  };
}
