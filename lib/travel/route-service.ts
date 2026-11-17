import { haversineMeters, isCoordinates, type Coordinates } from "./location";

export type TravelRouteInput = { origin: Coordinates; destination: Coordinates; mode: "foot" | "car" };
export type TravelRoute = { distance: number; coordinates: [number, number][] };
type RouteService = (input: unknown) => Promise<TravelRoute>;

const BELGRADE: Coordinates = { latitude: 44.8125, longitude: 20.4612 };
const MAX_DISTANCE_METERS = 100_000;
const CACHE_TTL_MS = 5 * 60_000;
const CACHE_LIMIT = 128;
const UPSTREAM_INTERVAL_MS = 1_000;
const NO_STORE = { "Cache-Control": "private, no-store, max-age=0", "X-Content-Type-Options": "nosniff" };
class BodyTooLargeError extends Error {}

export class TravelRouteError extends Error {
  readonly status: number;
  readonly retryAfter?: number;

  constructor(message: string, status: number, retryAfter?: number) {
    super(message);
    this.name = "TravelRouteError";
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function inRegion(value: unknown): value is Coordinates {
  return isCoordinates(value) && value.latitude >= 41.8 && value.latitude <= 46.3 &&
    value.longitude >= 18.7 && value.longitude <= 23.1 &&
    haversineMeters(BELGRADE, value) <= MAX_DISTANCE_METERS;
}

export function parseTravelRouteInput(value: unknown): TravelRouteInput {
  if (!record(value) || Object.keys(value).some(key => !["origin", "destination", "mode"].includes(key)) ||
      !inRegion(value.origin) || !inRegion(value.destination) ||
      (value.mode !== "foot" && value.mode !== "car") ||
      haversineMeters(value.origin, value.destination) > MAX_DISTANCE_METERS) {
    throw new TravelRouteError("Invalid route request.", 400);
  }
  return { origin: value.origin, destination: value.destination, mode: value.mode };
}

async function boundedJson(stream: ReadableStream<Uint8Array> | null, limit: number): Promise<unknown> {
  if (!stream) throw new Error("Missing body");
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new BodyTooLargeError("Body too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function streetRoute(value: unknown): TravelRoute {
  const first = record(value) && value.code === "Ok" && Array.isArray(value.routes) ? value.routes[0] : null;
  const geometry = record(first) && record(first.geometry) ? first.geometry : null;
  if (!record(first) || typeof first.distance !== "number" || !Number.isFinite(first.distance) ||
      first.distance < 0 || first.distance > 400_000 || geometry?.type !== "LineString" ||
      !Array.isArray(geometry.coordinates) || geometry.coordinates.length < 2 || geometry.coordinates.length > 40_000) {
    throw new TravelRouteError("A street route is unavailable. Try again shortly.", 502);
  }
  const coordinates: [number, number][] = [];
  for (const point of geometry.coordinates) {
    if (!Array.isArray(point) || point.length !== 2 || typeof point[0] !== "number" ||
        typeof point[1] !== "number" || !Number.isFinite(point[0]) || !Number.isFinite(point[1]) ||
        Math.abs(point[0]) > 180 || Math.abs(point[1]) > 90) {
      throw new TravelRouteError("A street route is unavailable. Try again shortly.", 502);
    }
    coordinates.push([point[0], point[1]]);
  }
  return { distance: first.distance, coordinates };
}

// One process-wide service is shared by all visitors. Coordinates live only in
// this bounded memory cache; neither Next's data cache nor logs receive GPS.
export function createTravelRouteService(options: {
  fetcher?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
} = {}): RouteService {
  const fetcher = options.fetcher ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 4_000;
  const cache = new Map<string, { route: TravelRoute; expires: number; timer: ReturnType<typeof setTimeout> }>();
  const inflight = new Map<string, Promise<TravelRoute>>();
  let nextUpstreamAt = 0;

  async function upstream(url: string): Promise<TravelRoute> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new TravelRouteError("The route took too long. Try again shortly.", 504));
        controller.abort();
      }, timeoutMs);
    });
    try {
      const result = (async () => {
        const response = await fetcher(url, {
          cache: "no-store", redirect: "error", signal: controller.signal,
          headers: { Accept: "application/json", "User-Agent": "EventZeka/1.0 (https://eventzeka.com)" },
        });
        if (response.status === 429) {
          nextUpstreamAt = Math.max(nextUpstreamAt, now() + 5_000);
          throw new TravelRouteError("Routing is busy. Try again shortly.", 429, 5);
        }
        if (!response.ok || Number(response.headers.get("content-length")) > 2_000_000) {
          throw new TravelRouteError("A street route is unavailable. Try again shortly.", 502);
        }
        return streetRoute(await boundedJson(response.body, 2_000_000));
      })();
      return await Promise.race([result, deadline]);
    } catch (error) {
      if (error instanceof TravelRouteError) throw error;
      throw new TravelRouteError("A street route is unavailable. Try again shortly.", 502);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return async input => {
    const { origin, destination, mode } = parseTravelRouteInput(input);
    const points = [origin, destination].map(point => `${point.longitude.toFixed(5)},${point.latitude.toFixed(5)}`).join(";");
    const key = `${mode}:${points}`;
    const hit = cache.get(key);
    if (hit && hit.expires > now()) {
      cache.delete(key); cache.set(key, hit);
      return hit.route;
    }
    if (hit) { clearTimeout(hit.timer); cache.delete(key); }
    const pending = inflight.get(key);
    if (pending) return pending;
    if (now() < nextUpstreamAt) {
      throw new TravelRouteError("Routing is busy. Try again shortly.", 429, Math.max(1, Math.ceil((nextUpstreamAt - now()) / 1_000)));
    }
    nextUpstreamAt = now() + UPSTREAM_INTERVAL_MS;
    // Only these two fixed upstream profiles can be selected. No caller URL,
    // hostname, path or query parameter ever reaches the upstream request.
    const url = `https://routing.openstreetmap.de/routed-${mode}/route/v1/driving/${points}?overview=full&geometries=geojson&steps=false`;
    const promise = upstream(url).then(route => {
      const timer = setTimeout(() => { cache.delete(key); }, CACHE_TTL_MS);
      timer.unref();
      cache.set(key, { route, expires: now() + CACHE_TTL_MS, timer });
      while (cache.size > CACHE_LIMIT) {
        const oldest = cache.keys().next().value!;
        clearTimeout(cache.get(oldest)!.timer);
        cache.delete(oldest);
      }
      return route;
    }).finally(() => { inflight.delete(key); });
    inflight.set(key, promise);
    return promise;
  };
}

const routeService = createTravelRouteService();

export async function handleTravelRouteRequest(request: Request, service: RouteService = routeService): Promise<Response> {
  const reply = (error: string, status: number, retryAfter?: number) => Response.json({ error }, {
    status, headers: { ...NO_STORE, ...(retryAfter ? { "Retry-After": String(retryAfter) } : {}) },
  });
  const origin = request.headers.get("origin");
  let sameOrigin = false;
  try {
    const parsed = new URL(origin ?? "");
    const allowedProtocol = parsed.protocol === "https:" || (process.env.NODE_ENV !== "production" && parsed.protocol === "http:");
    sameOrigin = parsed.origin === origin && allowedProtocol &&
      (parsed.origin === new URL(request.url).origin || parsed.host === request.headers.get("host"));
  } catch { /* An absent or malformed Origin is rejected. */ }
  if (!sameOrigin || request.headers.get("sec-fetch-site") === "cross-site") return reply("Same-origin requests only.", 403);
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return reply("Use an application/json body.", 415);
  }
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > 2_048)) return reply("Invalid request body size.", 413);
  let input: unknown;
  try { input = await boundedJson(request.body, 2_048); }
  catch (error) { return reply("Invalid or oversized JSON body.", error instanceof BodyTooLargeError ? 413 : 400); }
  try {
    return Response.json(await service(input), { headers: NO_STORE });
  } catch (error) {
    if (error instanceof TravelRouteError) return reply(error.message, error.status, error.retryAfter);
    return reply("A street route is unavailable. Try again shortly.", 502);
  }
}
