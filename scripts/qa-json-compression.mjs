import assert from "node:assert/strict";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { compressedPublicJson, negotiateJsonEncoding } from "../lib/http/compressed-json.ts";

const data = { groups: Array.from({ length: 300 }, (_, index) => ({ date: "2026-11-06", category: "live", count: index, venue: `venue-${index % 10}` })), generatedAt: 123 };
const original = JSON.stringify(data);
for (const [accept, expected] of [["gzip", "gzip"], ["gzip, br", "br"], ["gzip;q=0.9,br;q=0.2", "gzip"], ["*", "br"]]) {
  const response = await compressedPublicJson(data, new Headers({ "accept-encoding": accept }), { headers: { "Cache-Control": "no-store", Vary: "Origin" } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-encoding"), expected);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("vary"), "Origin, Accept-Encoding");
  const encoded = Buffer.from(await response.arrayBuffer());
  assert.equal(Number(response.headers.get("content-length")), encoded.length);
  assert.ok(encoded.length < Buffer.byteLength(original) / 2);
  assert.deepEqual(JSON.parse((expected === "br" ? brotliDecompressSync(encoded) : gunzipSync(encoded)).toString()), data);
}
for (const accept of [null, "identity", "gzip;q=0,br;q=0", "deflate", "identity;q=1,gzip;q=0.2"]) {
  const response = await compressedPublicJson(data, new Headers(accept ? { "accept-encoding": accept } : {}));
  assert.equal(response.headers.get("content-encoding"), null);
  assert.deepEqual(await response.json(), data);
}
const small = await compressedPublicJson({ ok: true }, new Headers({ "accept-encoding": "br,gzip" }));
assert.equal(small.headers.get("content-encoding"), null);
assert.equal(small.headers.get("vary"), "Accept-Encoding");
const forced = await compressedPublicJson({ ok: true }, new Headers({ "accept-encoding": "identity;q=0,gzip" }));
assert.equal(forced.headers.get("content-encoding"), "gzip");
assert.deepEqual(JSON.parse(gunzipSync(Buffer.from(await forced.arrayBuffer())).toString()), { ok: true });
const refused = await compressedPublicJson(data, new Headers({ "accept-encoding": "*;q=0" }));
assert.equal(refused.status, 406);
assert.equal((await refused.arrayBuffer()).byteLength, 0);
assert.equal(negotiateJsonEncoding("br;q=0,*;q=0.5").coding, "gzip");
assert.equal(negotiateJsonEncoding("gzip;q=NaN").coding, "identity");
console.log("Public JSON compression QA passed: negotiated Brotli/gzip, quality exclusions, identity fallback, small bodies, byte-exact JSON and unchanged no-store policy.");
