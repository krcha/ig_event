import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { ConvexHttpClient } from 'convex/browser';
import { createCarouselJpegCache } from '../lib/social/carousel-jpeg-cache.ts';
import { buildAgendaRenderVersion } from '../lib/social/daily-carousel.ts';
import { buildClosingCtaRenderVersion } from '../lib/social/carousel-cta.ts';
import { GET as getAgenda, HEAD as headAgenda } from '../app/api/social/carousel/days/[date]/route.ts';
import { GET as getClosing, HEAD as headClosing } from '../app/api/social/carousel/cta/route.ts';

const temporary = await mkdtemp(path.join(os.tmpdir(), 'qa-carousel-jpeg-cache-'));
const previous = { directory: process.env.EVENTZEKA_IMAGE_CACHE_DIR, convex: process.env.NEXT_PUBLIC_CONVEX_URL, query: ConvexHttpClient.prototype.query };
const metrics = {};
try {
  const bytes = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#bb3344' } }).jpeg().toBuffer();
  const directory = path.join(temporary, 'unit'), cached = createCarouselJpegCache({ directory, maxEntries: 2 });
  let renders = 0;
  const render = async () => { renders++; return bytes; };
  assert.deepEqual(await cached({ version: 'v1' }, render), bytes);
  assert.deepEqual(await cached({ version: 'v1' }, render), bytes);
  assert.equal(renders, 1, 'a repeated image request reuses identical JPEG bytes');
  const anotherProcess = createCarouselJpegCache({ directory });
  assert.deepEqual(await anotherProcess({ version: 'v1' }, render), bytes);
  assert.equal(renders, 1, 'a new cache instance reuses persisted JPEG bytes');

  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const together = Array.from({ length: 5 }, () => cached({ version: 'v2' }, async () => { renders++; await gate; return bytes; }));
  release();
  assert((await Promise.all(together)).every(result => result.equals(bytes)));
  assert.equal(renders, 2, 'concurrent GET/HEAD work coalesces into one render');
  await cached({ version: 'v3' }, render);
  assert.equal(renders, 3, 'changed content/render version has a separate cache key');
  assert.equal((await readdir(directory)).filter(file => file.endsWith('.jpg')).length, 2, 'entry bound evicts old images');

  const byteBoundDir = path.join(temporary, 'byte-bound');
  const larger = await sharp(randomBytes(1500 * 1500 * 3), { raw: { width: 1500, height: 1500, channels: 3 } }).jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).toBuffer();
  assert(larger.length < 8_000_000 && larger.length * 2 > 8_000_000);
  const byteBounded = createCarouselJpegCache({ directory: byteBoundDir, maxBytes: 8_000_000 });
  await byteBounded('first', async () => larger); await byteBounded('second', async () => larger);
  assert.equal((await readdir(byteBoundDir)).filter(file => file.endsWith('.jpg')).length, 1, 'byte limit evicts an older image even below the entry bound');

  const expiredDir = path.join(temporary, 'expired'), expiring = createCarouselJpegCache({ directory: expiredDir, maxAgeMs: 1_000 });
  await expiring('same', render);
  const old = new Date(Date.now() - 5_000);
  for (const filename of await readdir(expiredDir)) await utimes(path.join(expiredDir, filename), old, old);
  await expiring('same', render);
  assert.equal(renders, 5, 'expired disk image rerenders');
  const failedDir = path.join(temporary, 'failed'), retry = createCarouselJpegCache({ directory: failedDir });
  await assert.rejects(retry('same', async () => { throw new Error('render rejected'); }), /render rejected/);
  assert.deepEqual(await retry('same', render), bytes, 'failed render clears in-flight work and never caches an error');
  const corruptDir = path.join(temporary, 'corrupt'), corrupt = createCarouselJpegCache({ directory: corruptDir });
  await corrupt('same', render);
  await writeFile(path.join(corruptDir, (await readdir(corruptDir))[0]), Buffer.from('not a jpeg'));
  const beforeCorrupt = renders;
  await corrupt('same', render);
  assert.equal(renders, beforeCorrupt + 1, 'invalid cached file is replaced with a rendered JPEG');
  const inaccessible = path.join(temporary, 'not-a-directory');
  await writeFile(inaccessible, 'file');
  assert.deepEqual(await createCarouselJpegCache({ directory: inaccessible })('x', render), bytes, 'cache I/O failure still returns the valid render');

  process.env.EVENTZEKA_IMAGE_CACHE_DIR = path.join(temporary, 'routes');
  process.env.NEXT_PUBLIC_CONVEX_URL = 'https://qa-cache.convex.cloud';
  const date = '2026-10-21', publishDate = '2026-10-20';
  const events = Array.from({ length: 3 }, (_, index) => ({ _id: `qacacheevent00${index}`, title: ['Veče poezije', 'Živa svirka', 'Đuskanje do ponoći'][index], venue: `Prostor ${index}`, date, time: `${19 + index}:00`, timeStatus: 'confirmed', timeSource: 'caption', status: 'approved' }));
  const version = buildAgendaRenderVersion(date, events, 0, publishDate);
  const url = new URL(`https://eventzeka.com/api/social/carousel/days/${date}`);
  url.searchParams.set('events', events.map(event => event._id).join(','));
  url.searchParams.set('position', '0'); url.searchParams.set('v', version); url.searchParams.set('publishDate', publishDate);
  const context = { params: Promise.resolve({ date }) };
  let queries = 0, queryResult = id => events.find(event => event._id === id);
  ConvexHttpClient.prototype.query = async (_, args) => { queries++; return queryResult(args.id); };
  const initial = await headAgenda(new Request(url, { method: 'HEAD' }), context);
  assert.equal(initial.status, 200);
  assert.equal((await initial.arrayBuffer()).byteLength, 0, 'explicit HEAD warms the JPEG without a response body');
  const started = performance.now(), hit = await getAgenda(new Request(url), context);
  const poster = Buffer.from(await hit.arrayBuffer()); metrics.warmRouteMs = Math.round(performance.now() - started);
  assert.equal(hit.status, 200); assert.equal(hit.headers.get('content-length'), String(poster.length));
  assert.equal(hit.headers.get('content-type'), 'image/jpeg');
  assert.equal(hit.headers.get('cache-control'), 'public, max-age=60, must-revalidate');
  assert.equal(initial.headers.get('content-length'), String(poster.length));
  assert.equal(queries, 6, 'HEAD and cached GET each revalidate all three exact public IDs');
  const repeated = Buffer.from(await (await getAgenda(new Request(url), context)).arrayBuffer());
  assert.deepEqual(repeated, poster); assert.equal(queries, 9);
  const metadata = await sharp(poster).metadata();
  assert.deepEqual([metadata.format, metadata.width, metadata.height], ['jpeg', 1080, 1350]);
  for (const [label, result, expected] of [
    ['moderation', id => ({ ...events.find(event => event._id === id), status: 'pending' }), 404],
    ['deleted/private event', () => null, 404],
    ['event occurrence changed', id => ({ ...events.find(event => event._id === id), date: '2026-10-22' }), 404],
    ['identity mismatch', id => ({ ...events.find(event => event._id === id), _id: 'differentpublicid' }), 404],
    ['changed title/render version', id => ({ ...events.find(event => event._id === id), title: 'Changed title' }), 409],
  ]) {
    const before = queries; queryResult = result;
    assert.equal((await getAgenda(new Request(url), context)).status, expected, `${label} is rechecked before an existing cache hit`);
    assert.equal(queries - before, 3);
  }
  const beforeFailure = queries;
  queryResult = () => { throw new Error('query unavailable'); };
  assert.equal((await getAgenda(new Request(url), context)).status, 503, 'cached image does not mask unavailable public validation');
  assert.equal(queries - beforeFailure, 3);
  queryResult = id => events.find(event => event._id === id);
  const duplicate = new URL(url); duplicate.searchParams.append('events', duplicate.searchParams.get('events'));
  assert.equal((await getAgenda(new Request(duplicate), context)).status, 400);
  const closing = new URL('https://eventzeka.com/api/social/carousel/cta');
  closing.searchParams.set('date', publishDate); closing.searchParams.set('v', buildClosingCtaRenderVersion(publishDate));
  const closingHead = await headClosing(new Request(closing, { method: 'HEAD' }));
  assert.equal(closingHead.status, 200); assert.equal((await closingHead.arrayBuffer()).byteLength, 0);
  const closingBytes = Buffer.from(await (await getClosing(new Request(closing))).arrayBuffer());
  assert.equal(closingHead.headers.get('content-length'), String(closingBytes.length));
  assert.deepEqual(Buffer.from(await (await getClosing(new Request(closing))).arrayBuffer()), closingBytes, 'CTA uses its own stable JPEG cache');
  const staleClosing = new URL(closing); staleClosing.searchParams.set('v', 'stale');
  assert.equal((await getClosing(new Request(staleClosing))).status, 409, 'CTA render version is checked before cache lookup');
  metrics.status = 'passed'; metrics.routeChecks = 13; metrics.singleFlightRequests = 5;
  console.log(JSON.stringify(metrics));
  console.log('Carousel JPEG cache QA passed: disk reuse, coalesced render, version isolation, bounded entries/age, error recovery, HEAD/GET parity and live public validation before cached images.');
} finally {
  ConvexHttpClient.prototype.query = previous.query;
  for (const [key, value] of [['EVENTZEKA_IMAGE_CACHE_DIR', previous.directory], ['NEXT_PUBLIC_CONVEX_URL', previous.convex]]) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await rm(temporary, { recursive: true, force: true });
}
