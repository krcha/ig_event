import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";

const brotli = promisify(brotliCompress);
const gzipAsync = promisify(gzip);
const MIN_COMPRESS_BYTES = 1024;
type Coding = "br" | "gzip" | "identity";

/** Public JSON only: preserve the caller's cache/privacy policy. */
export function negotiateJsonEncoding(value: string | null): {
  coding: Coding | null;
  identityAllowed: boolean;
} {
  if (!value?.trim()) return { coding: "identity", identityAllowed: true };
  const weights = new Map<string, number>();
  for (const entry of value.split(",")) {
    const [name, ...parameters] = entry.trim().toLowerCase().split(";");
    if (!name) continue;
    const quality = parameters.map(part => part.trim()).find(part => part.startsWith("q="));
    const parsed = quality === undefined ? 1 : Number(quality.slice(2));
    weights.set(name, Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0);
  }
  const wildcard = weights.get("*");
  const identity = weights.get("identity") ?? (wildcard === 0 ? 0 : 1);
  const candidates: Array<[Coding, number]> = [
    ["br", weights.get("br") ?? wildcard ?? 0],
    ["gzip", weights.get("gzip") ?? wildcard ?? 0],
  ];
  candidates.sort((a, b) => b[1] - a[1]);
  const best = candidates.find(([, quality]) => quality > 0);
  const coding = weights.has("identity") && identity > 0 && (!best || identity > best[1])
    ? "identity" : best?.[0] ?? (identity > 0 ? "identity" : null);
  return { coding, identityAllowed: identity > 0 };
}

export async function compressedPublicJson(
  data: unknown,
  requestHeaders: Headers,
  init: ResponseInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  // Encoding is a transport concern, not permission to share/cache a response.
  const vary = new Set((headers.get("Vary") ?? "").split(",").map(value => value.trim()).filter(Boolean));
  if (![...vary].some(value => value.toLowerCase() === "accept-encoding")) vary.add("Accept-Encoding");
  headers.set("Vary", [...vary].join(", "));
  const { coding, identityAllowed } = negotiateJsonEncoding(requestHeaders.get("accept-encoding"));
  if (coding === null) return new Response(null, { ...init, status: 406, headers });
  const text = JSON.stringify(data);
  const bytes = Buffer.from(text);
  if (coding === "identity" || (bytes.byteLength < MIN_COMPRESS_BYTES && identityAllowed)) {
    return new Response(text, { ...init, headers });
  }
  const encoded = coding === "br"
    ? await brotli(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } })
    : await gzipAsync(bytes, { level: 6 });
  headers.set("Content-Encoding", coding);
  headers.set("Content-Length", String(encoded.byteLength));
  return new Response(new Uint8Array(encoded), { ...init, headers });
}
