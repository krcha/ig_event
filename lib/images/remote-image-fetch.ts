import {
  assertImageResponseHeaders,
  DEFAULT_MAX_IMAGE_BYTES,
  readImageResponseBodyWithLimit,
} from "@/lib/images/image-response-guardrails";
import { assertAllowedRemoteImageUrl } from "@/lib/images/remote-image-policy";

export const DEFAULT_REMOTE_IMAGE_TIMEOUT_MS = 15_000;
export const DEFAULT_REMOTE_IMAGE_MAX_REDIRECTS = 3;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

type FetchImplementation = (input: string, init: RequestInit) => Promise<Response>;

export type FetchedRemoteRasterImage = {
  bytes: Buffer;
  contentType: string;
  finalUrl: string;
  redirectCount: number;
};

export async function fetchAllowedRemoteRasterImage(
  initialUrl: string,
  options: {
    fetchImpl?: FetchImplementation;
    maxBytes?: number;
    maxRedirects?: number;
    timeoutMs?: number;
  } = {},
): Promise<FetchedRemoteRasterImage> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_REMOTE_IMAGE_MAX_REDIRECTS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_REMOTE_IMAGE_TIMEOUT_MS;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("Remote image byte limit must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 10) {
    throw new Error("Remote image redirect limit is invalid.");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error("Remote image timeout is invalid.");
  }

  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new Error(`Remote image fetch exceeded ${timeoutMs}ms.`));
    }, timeoutMs);
  });

  let currentUrl = assertAllowedRemoteImageUrl(initialUrl);
  let redirectCount = 0;

  try {
    while (true) {
      const response = await Promise.race([
        fetchImpl(currentUrl.toString(), {
          cache: "no-store",
          headers: { accept: "image/*,*/*;q=0.8" },
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
        }),
        timeoutPromise,
      ]);

      if (REDIRECT_STATUSES.has(response.status)) {
        if (redirectCount >= maxRedirects) {
          await response.body?.cancel().catch(() => undefined);
          throw new Error(`Remote image exceeded ${maxRedirects} redirects.`);
        }
        const location = response.headers.get("location");
        if (!location) {
          await response.body?.cancel().catch(() => undefined);
          throw new Error("Remote image redirect is missing a Location header.");
        }
        const redirectUrl = new URL(location, currentUrl);
        currentUrl = assertAllowedRemoteImageUrl(redirectUrl.toString());
        redirectCount += 1;
        await response.body?.cancel().catch(() => undefined);
        continue;
      }

      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`Remote image fetch failed with status ${response.status}.`);
      }

      const contentType = assertImageResponseHeaders(response, { maxBytes });
      const bytes = await Promise.race([
        readImageResponseBodyWithLimit(response, { maxBytes }),
        timeoutPromise,
      ]);
      return {
        bytes,
        contentType,
        finalUrl: currentUrl.toString(),
        redirectCount,
      };
    }
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
