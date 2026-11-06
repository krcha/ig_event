import {
  assertImageResponseHeaders,
  readImageResponseBodyWithLimit,
} from "@/lib/images/image-response-guardrails";
import { fetchAllowedRemoteRasterImage } from "@/lib/images/remote-image-fetch";

export type PublicEventImageSource =
  | { eventExists: false; kind: "none" }
  | { eventExists: true; kind: "none" }
  | { eventExists: true; kind: "stored"; storageId: string; url: string }
  | { eventExists: true; kind: "upstream"; url: string };

export type AvailablePublicEventImageSource = Exclude<PublicEventImageSource, { kind: "none" }>;
export type PublicEventRaster = { bytes: Buffer; contentType: string };

// The caller must first resolve the current public source through
// mediaAssets:getPublicEventImageSource. Never accept a source URL from a request.
// This only reads original bytes; it never updates storage or ingestion media.
export async function fetchPublicEventRaster(
  source: AvailablePublicEventImageSource,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<PublicEventRaster> {
  if (source.kind === "upstream") {
    return fetchAllowedRemoteRasterImage(source.url, {
      timeoutMs: 12_000,
      fetchImpl: options.fetchImpl,
    });
  }

  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new Error("Stored image fetch timed out."));
    }, 12_000);
  });
  try {
    const response = await Promise.race([
      (options.fetchImpl ?? fetch)(source.url, {
        cache: "no-store",
        headers: { accept: "image/*,*/*;q=0.8" },
        signal: controller.signal,
      }),
      timeoutPromise,
    ]);
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Stored image fetch failed with status ${response.status}.`);
    }
    const contentType = assertImageResponseHeaders(response);
    const bytes = await Promise.race([
      readImageResponseBodyWithLimit(response),
      timeoutPromise,
    ]);
    return { bytes, contentType };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
