import "server-only";
import { ConvexHttpClient } from "convex/browser";
import { getCalendarConvexUrl } from "../events/calendar-convex-url";

export function getTravelReadClient(signal: AbortSignal) {
  const url = getCalendarConvexUrl();
  if (!url) throw new Error("Public listings unavailable.");
  return new ConvexHttpClient(url, { fetch: (input, init) => fetch(input, { ...init, signal }) });
}

/** A caller waiting on another request's in-flight cache entry also has a deadline. */
export async function readTravelPart<T>(deadlineMs: number, read: (client: ConvexHttpClient) => Promise<T>) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error("Public listings timed out.")); }, deadlineMs);
  });
  try {
    return await Promise.race([read(getTravelReadClient(controller.signal)), deadline]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
