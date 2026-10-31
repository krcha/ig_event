import { readFileSync } from "node:fs";
import path from "node:path";
import { create, type Font } from "fontkit";
import { AgendaRenderError, cleanAgendaText, getAgendaFonts, getExtendedFallbackFont, measureAgendaText, type PreparedAgendaEvent, type TextBlock } from "./agenda-layout.ts";
import { getPosterDirection, type PosterFormat, type PosterFontKey } from "./poster-directions.ts";

export const POSTER_TIME_FRAME = { width: 168, height: 108, fontSize: 30, radius: 5 } as const;
export const POSTER_SAFE_AREA = { left: 48, right: 938, top: 226, bottom: 1560 } as const;
export type PosterDirection = ReturnType<typeof getPosterDirection>;
let artFonts: Record<PosterFontKey, Font> | undefined;
function load(filename: string): Font {
  const font = create(readFileSync(path.join(process.cwd(), "public/fonts/social", filename)));
  if (!("layout" in font)) throw new AgendaRenderError("Invalid artwork font.");
  return font;
}
export function getPosterFonts() {
  if (!artFonts) artFonts = {
    archivo: load("ArchivoBlack.ttf"), barlow: getAgendaFonts().weekday,
    fraunces: load("Fraunces.ttf").getVariation({ wght: 650, opsz: 90, SOFT: 20, WONK: 1 }),
    syne: load("Syne.ttf").getVariation({ wght: 700 }),
    rubik: load("RubikMonoOne.ttf"), bodoni: load("BodoniModa.ttf").getVariation({ wght: 750, opsz: 24 }),
  };
  return artFonts;
}
export function posterFont(font: Font, value: string, body = false): Font {
  if (Array.from(value).every(char => font.hasGlyphForCodePoint(char.codePointAt(0)!))) return font;
  const fallback = body ? getAgendaFonts().fallbackBody : getAgendaFonts().fallbackTitle;
  if (Array.from(value).every(char => fallback.hasGlyphForCodePoint(char.codePointAt(0)!))) return fallback;
  const extended = getExtendedFallbackFont(value);
  if (extended) return extended;
  throw new AgendaRenderError("Event text contains unsupported identity characters.");
}
export function wrapPosterText(value: string, font: Font, size: number, width: number): string[] {
  const lines: string[] = []; let line = "";
  for (const word of value.split(" ").filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (measureAgendaText(font, next, size).width <= width) { line = next; continue; }
    if (line) { lines.push(line); line = ""; }
    for (const char of Array.from(word)) {
      const next = line + char;
      if (measureAgendaText(font, next, size).width > width) {
        if (!line) throw new AgendaRenderError("Event text cannot fit its programme width.");
        lines.push(line); line = char;
      } else line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}
export function posterTextBlock(value: string, font: Font, size: number, width: number, body = false): TextBlock {
  font = posterFont(font, value, body);
  const lines = wrapPosterText(value, font, size, width), lineHeight = Math.ceil(size * 1.13);
  return { font, size, spacing: 0, lines, lineHeight,
    height: lines.length ? (lines.length - 1) * lineHeight + Math.max(...lines.map(line => measureAgendaText(font, line, size).height)) : 0 };
}
export type PosterRow = {
  x: number; top: number; width: number; height: number; bodyX: number; bodyTop: number;
  title: TextBlock; venue: TextBlock; detail?: TextBlock; venueTop: number; detailTop: number;
  timeLines: string[]; timeX: number; timeY: number; flip: boolean;
};
export function buildPosterLayout(events: PreparedAgendaEvent[], options: { date: string; position?: number; format?: PosterFormat; publishDate?: string }) {
  const format = options.format || "feed", vertical = format !== "feed";
  const theme = getPosterDirection(options.date, options.position || 0, format, options.publishDate);
  if (events.length < 1 || events.length > (vertical ? 4 : 3)) throw new AgendaRenderError(vertical ? "Poster requires one to four events." : "Poster requires one to three events.");
  const source = events.map(event => {
    const title = cleanAgendaText(event.title), venue = cleanAgendaText(event.venue, 300);
    if (!title || !venue) throw new AgendaRenderError("Poster requires complete event and venue identities.");
    return { ...event, title, venue };
  });
  const fonts = getAgendaFonts(), preferred = getPosterFonts()[theme.eventFont];
  const listTop = vertical ? 556 : 366, listBottom = vertical ? 1455 : 1150, gap = vertical ? 15 : 17;
  const available = listBottom - listTop - gap * (events.length - 1);
  const primarySize = vertical ? 52 : 57;
  const choices = [
    { details: true, font: preferred, size: primarySize },
    ...[primarySize, primarySize - 4, primarySize - 8, 40].map(size => ({ details: false, font: preferred, size })),
    ...[56, 52, 48, 44, 40].map(size => ({ details: false, font: fonts.title, size })),
  ];
  for (const choice of choices) {
    const candidates = source.map((event, index) => {
      const defaultFlip = theme.panel === "sunday" || theme.panel === "haze" || ((theme.panel === "ticket" || theme.panel === "sleeve") && index % 2 === 1);
      const flip = theme.composition === 0 ? defaultFlip : theme.composition === 1 ? !defaultFlip : index % 2 === 1;
      const shift = (theme.composition === 2 || ["night", "sleeve", "tribal"].includes(theme.panel)) ? (index % 2) * 12 : 0;
      const x = (vertical ? 64 : 62) + shift, width = (vertical ? 862 : 956) - shift;
      const bodyX = flip ? x + 26 : x + 216, bodyWidth = width - 246;
      const title = posterTextBlock(event.title, choice.font, choice.size, bodyWidth);
      const venue = posterTextBlock(event.venue, fonts.venue, vertical ? 28 : 31, bodyWidth, true);
      let detail: TextBlock | undefined;
      if (choice.details && event.detail) {
        const clean = cleanAgendaText(event.detail, 600), candidate = posterTextBlock(clean, fonts.body, vertical ? 25 : 27, bodyWidth, true);
        if (candidate.lines.length <= 2) detail = candidate;
      }
      const time = cleanAgendaText(event.time || "", 72), [start, end] = time.split(/[-\u2013\u2014]/);
      const timeLines = start ? [start, ...(end ? [`\u2013${end}`] : [])] : ["\u2014"];
      if (timeLines.some(line => measureAgendaText(fonts.time, line, POSTER_TIME_FRAME.fontSize).width > POSTER_TIME_FRAME.width - 18)) throw new AgendaRenderError("Complete time cannot fit its standard frame.");
      const bodyHeight = title.height + 14 + venue.height + (detail ? 13 + detail.height : 0);
      return { x, width, bodyX, title, venue, detail, timeLines, flip, bodyHeight, minHeight: Math.max(bodyHeight, 108) + 46 };
    });
    const total = candidates.reduce((n, row) => n + row.minHeight, 0);
    if (total > available) continue;
    const extra = Math.min((available - total) / events.length, events.length < 3 ? 90 : Infinity);
    let top = listTop;
    const rows: PosterRow[] = candidates.map(row => {
      const height = row.minHeight + extra, bodyTop = top + (height - row.bodyHeight) / 2;
      const venueTop = bodyTop + row.title.height + 14, detailTop = venueTop + row.venue.height + 13;
      const result = { ...row, top, height, bodyTop, venueTop, detailTop, timeX: row.flip ? row.x + row.width - 190 : row.x + 22, timeY: top + (height - 108) / 2 };
      top += height + gap; return result;
    });
    return { theme, rows, height: vertical ? 1920 : 1350, format };
  }
  throw new AgendaRenderError("Complete event identities cannot fit safely on this poster.");
}
export function getPosterTagPositions(events: PreparedAgendaEvent[], options: { date: string; position: number; format?: PosterFormat; publishDate?: string }) {
  const layout = buildPosterLayout(events, options);
  return layout.rows.map(row => ({
    x: Number(((row.bodyX + Math.max(...row.venue.lines.map(line => measureAgendaText(row.venue.font, line, row.venue.size).width)) / 2) / 1080).toFixed(4)),
    y: Number(((row.venueTop + row.venue.height / 2) / layout.height).toFixed(4)),
  }));
}
