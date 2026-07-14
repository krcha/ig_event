import {
  DEFAULT_MAX_IMAGE_BYTES,
  assertImageResponseHeaders,
} from "@/lib/images/image-response-guardrails";
import {
  isApifyImageUrl,
  isInstagramCdnImageUrl,
} from "@/lib/images/apify-images";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
export const DEFAULT_IMAGE_FETCH_TIMEOUT_MS = 12_000;
export const DEFAULT_IMAGE_REDIRECT_LIMIT = 3;

export type TrustedImageFetchResult = {
  bytes: Uint8Array<ArrayBuffer>;
  contentType: string;
  finalUrl: string;
};

function normalizeTrustedStoredOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function isTrustedEventImageUrl(
  value: string | null | undefined,
  options: { storedMediaOrigin?: string | null } = {},
): value is string {
  if (!value) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (isApifyImageUrl(value) || isInstagramCdnImageUrl(value)) {
    return url.protocol === "https:" && url.port === "";
  }

  const storedMediaOrigin = normalizeTrustedStoredOrigin(options.storedMediaOrigin);
  return Boolean(storedMediaOrigin && url.origin === storedMediaOrigin);
}

async function readResponseBytes(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!response.body) throw new Error("Image response body is empty.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        throw new Error(`Image response exceeds ${maxBytes} bytes.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (totalBytes === 0) throw new Error("Image response body is empty.");
  const output: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(totalBytes));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export async function fetchTrustedEventImage(
  sourceUrl: string,
  options: {
    fetchImpl?: typeof fetch;
    maxBytes?: number;
    maxRedirects?: number;
    storedMediaOrigin?: string | null;
    timeoutMs?: number;
  } = {},
): Promise<TrustedImageFetchResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_IMAGE_REDIRECT_LIMIT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_IMAGE_FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  let currentUrl = sourceUrl;

  try {
    for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
      if (!isTrustedEventImageUrl(currentUrl, options)) {
        throw new Error("Image URL host is not allowlisted.");
      }

      const response = await fetchImpl(currentUrl, {
        cache: "no-store",
        headers: { accept: "image/*,*/*;q=0.8" },
        redirect: "manual",
        signal: controller.signal,
      });

      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) throw new Error("Image redirect is missing a location header.");
        if (redirectCount >= maxRedirects) throw new Error("Image redirect limit exceeded.");
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }

      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Image request failed with HTTP ${response.status}.`);
      }

      const contentType = assertImageResponseHeaders(response, { maxBytes });
      const bytes = await readResponseBytes(response, maxBytes);
      return { bytes, contentType, finalUrl: currentUrl };
    }

    throw new Error("Image redirect limit exceeded.");
  } finally {
    clearTimeout(timeoutId);
  }
}
