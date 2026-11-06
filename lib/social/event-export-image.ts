import { createHash } from "node:crypto";
import type { Font } from "fontkit";
import sharp from "sharp";
import { getDisplayEventTime, type EventTimeStatus } from "../events/event-time.ts";
import {
  cleanAgendaText,
  getAgendaFonts,
  getExtendedFallbackFont,
  measureAgendaText,
  outlinedAgendaText,
} from "./agenda-layout.ts";

export const EVENT_EXPORT_DESIGN_VERSION = "event-story-dark-lime-v1";
export const EVENT_EXPORT_WIDTH = 1080;
export const EVENT_EXPORT_HEIGHT = 1920;
export const EVENT_EXPORT_MAX_BYTES = 2_000_000;

export type ExportablePublicEvent = {
  _id: string;
  title: string;
  venue: string;
  venueId?: string;
  date: string;
  time?: string;
  timeStatus?: EventTimeStatus | null;
  status: string;
  updatedAt?: number;
};

export function getEventExportFacts(event: ExportablePublicEvent) {
  const date = new Date(`${event.date}T12:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(event.date) ||
    !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== event.date) {
    throw new Error("Event export requires an announced calendar date.");
  }
  // Weekly venue hours and inferred starts are not event announcements.
  const announcedTime = event.timeStatus === "unknown" || event.timeStatus === "inferred"
    ? undefined : getDisplayEventTime(event.time);
  return {
    title: cleanAgendaText(event.title, 700),
    venue: cleanAgendaText(event.venue, 300),
    date: new Intl.DateTimeFormat("en-GB", {
      weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
    }).format(date),
    time: announcedTime ? `${announcedTime} / Belgrade time` : "Time not announced",
    url: `https://eventzeka.com/events/${event._id}`,
  };
}

function textFont(primary: Font, fallback: Font, text: string): Font {
  const supports = (font: Font) => Array.from(text).every(character =>
    font.hasGlyphForCodePoint(character.codePointAt(0)!));
  if (supports(primary)) return primary;
  if (supports(fallback)) return fallback;
  const extended = getExtendedFallbackFont(text);
  if (!extended) throw new Error("Event export contains unsupported characters.");
  return extended;
}

function wrap(text: string, font: Font, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ").filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word;
    if (measureAgendaText(font, candidate, size).width <= maxWidth) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    line = "";
    for (const character of Array.from(word)) {
      const candidate = line + character;
      if (measureAgendaText(font, candidate, size).width > maxWidth && line) {
        lines.push(line);
        line = character;
      } else line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function fittedText(text: string, font: Font, options: {
  x: number; top: number; width: number; height: number; maxSize: number; minSize: number; color: string;
}) {
  for (let size = options.maxSize; size >= options.minSize; size -= 2) {
    const lines = wrap(text, font, size, options.width);
    const step = size * 1.18;
    if (lines.length * step > options.height) continue;
    return lines.map((line, index) => outlinedAgendaText(
      line, font, size, options.x, options.top + index * step, options.color,
    )).join("");
  }
  throw new Error("Event identity does not fit the share image.");
}

export function buildEventExportSvg(event: ExportablePublicEvent, posterJpeg?: Buffer): string {
  const facts = getEventExportFacts(event);
  const fonts = getAgendaFonts();
  const titleFont = textFont(fonts.title, fonts.fallbackTitle, facts.title);
  const venueFont = textFont(fonts.venue, fonts.fallbackBody, facts.venue);
  const text = (value: string, size: number, x: number, top: number, color = "#F4F2EB") =>
    outlinedAgendaText(value, textFont(fonts.body, fonts.fallbackBody, value), size, x, top, color);
  const poster = posterJpeg
    ? `<image href="data:image/jpeg;base64,${posterJpeg.toString("base64")}" x="64" y="180" width="952" height="820" preserveAspectRatio="xMidYMid meet" clip-path="url(#poster)"/>`
    : `${text("Your next night", 68, 144, 470)}${text("starts here.", 68, 144, 570, "#D5F56B")}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920" viewBox="0 0 1080 1920">
    <defs><clipPath id="poster"><rect x="64" y="180" width="952" height="820" rx="28"/></clipPath></defs>
    <rect width="1080" height="1920" fill="#10141F"/>
    <circle cx="1040" cy="60" r="280" fill="#A99BFF" opacity="0.055"/>
    ${outlinedAgendaText("event zeka", fonts.brand, 52, 64, 74, "#D5F56B")}
    ${text("GO OUT. FIND YOUR PEOPLE.", 22, 650, 93, "#A8B0C2")}
    <rect x="64" y="180" width="952" height="820" rx="28" fill="#1B2233" stroke="#34405A" stroke-width="2"/>
    ${poster}
    ${fittedText(facts.title, titleFont, { x: 64, top: 1050, width: 952, height: 345, maxSize: 94, minSize: 26, color: "#F4F2EB" })}
    ${text("AT", 23, 64, 1438, "#A99BFF")}
    ${fittedText(facts.venue || "Venue to be announced", venueFont, { x: 64, top: 1482, width: 952, height: 115, maxSize: 48, minSize: 24, color: "#F4F2EB" })}
    <rect x="64" y="1634" width="6" height="98" rx="3" fill="#D5F56B"/>
    ${text(facts.date, 34, 94, 1638)}
    ${text(facts.time, 29, 94, 1694, "#A8B0C2")}
    <path d="M64 1782H1016" stroke="#34405A" stroke-width="2"/>
    ${text("FULL EVENT + ORIGINAL SOURCE", 20, 64, 1814, "#A8B0C2")}
    ${text(facts.url, 23, 64, 1858, "#D5F56B")}
  </svg>`;
}

export function eventExportSourceChecksum(bytes: Buffer | undefined): string {
  return bytes ? createHash("sha256").update(bytes).digest("hex") : "no-poster";
}

export async function renderEventExportImage(event: ExportablePublicEvent, poster?: Buffer): Promise<Buffer> {
  let posterJpeg: Buffer | undefined;
  if (poster) {
    try {
      posterJpeg = await sharp(poster, { limitInputPixels: 40_000_000, animated: false })
        .rotate().resize({ width: 952, height: 820, fit: "inside", withoutEnlargement: true })
        .flatten({ background: "#1B2233" }).jpeg({ quality: 86 }).timeout({ seconds: 5 }).toBuffer();
    } catch { /* A broken source poster must not erase the event's verified facts. */ }
  }
  const svg = Buffer.from(buildEventExportSvg(event, posterJpeg));
  const image = await sharp(svg, { limitInputPixels: 3_000_000 })
    .jpeg({ quality: 88, chromaSubsampling: "4:2:0" }).timeout({ seconds: 8 }).toBuffer();
  if (image.length > EVENT_EXPORT_MAX_BYTES) throw new Error("Event export exceeded its byte limit.");
  return image;
}
