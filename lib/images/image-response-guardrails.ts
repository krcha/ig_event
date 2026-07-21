export const DEFAULT_MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const RASTER_IMAGE_CONTENT_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/heic",
  "image/heif",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
]);

export function normalizeImageContentType(value: string | null): string {
  return value?.split(";")[0]?.trim().toLowerCase() ?? "";
}

export function isRasterImageContentType(value: string | null): boolean {
  return RASTER_IMAGE_CONTENT_TYPES.has(normalizeImageContentType(value));
}

export function assertImageResponseHeaders(
  response: Response,
  options: {
    maxBytes?: number;
  } = {},
): string {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  const contentType = response.headers.get("content-type");
  if (!isRasterImageContentType(contentType)) {
    throw new Error("Image response must be a supported raster content type.");
  }

  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    if (!/^\d+$/u.test(contentLength.trim())) {
      throw new Error("Image response has an invalid content-length header.");
    }
    const parsed = Number(contentLength);
    if (!Number.isSafeInteger(parsed)) {
      throw new Error("Image response has an invalid content-length header.");
    }
    if (parsed > maxBytes) {
      throw new Error(`Image response exceeds ${maxBytes} bytes.`);
    }
  }

  return normalizeImageContentType(contentType);
}

export async function readImageResponseBodyWithLimit(
  response: Response,
  options: {
    maxBytes?: number;
  } = {},
): Promise<Buffer> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  if (!response.body) {
    throw new Error("Image response body is empty.");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        throw new Error(`Image response exceeds ${maxBytes} bytes.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (totalBytes === 0) {
    throw new Error("Image response body is empty.");
  }

  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), totalBytes);
}
