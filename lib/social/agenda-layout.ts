import { readFileSync } from "node:fs";
import path from "node:path";
import { create, type Font } from "fontkit";

export const WIDTH = 1080;
export const HEIGHT = 1350;
export const MARGIN = 62;
export const BODY_X = 257;
export const BODY_WIDTH = WIDTH - MARGIN - BODY_X;
export const LIST_TOP = 400;
export const LIST_BOTTOM = 1218;
export const REEL_LIST_BOTTOM = 1328;
const ROW_PADDING = 54;
const UNSAFE_CONTROL_CHARACTERS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

export type PreparedAgendaEvent = {
  title: string;
  venue: string;
  time?: string;
  detail?: string;
};

export class AgendaRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgendaRenderError";
  }
}

export type PosterFonts = {
  title: Font;
  weekday: Font;
  body: Font;
  venue: Font;
  brand: Font;
  mono: Font;
  time: Font;
  fallbackTitle: Font;
  fallbackBody: Font;
};

let posterFonts: PosterFonts | undefined;
let japaneseFallback: Font | undefined;
let unicodeFallback: Font | undefined;

function loadFont(filename: string): Font {
  const font = create(
    readFileSync(path.join(process.cwd(), "public", "fonts", "social", filename)),
  );
  if (!("layout" in font)) {
    throw new Error("Agenda font must contain one font face.");
  }
  return font;
}

export function getAgendaFonts(): PosterFonts {
  if (!posterFonts) {
    const instrument = loadFont("InstrumentSans-Variable.ttf");
    const noto = loadFont("NotoSans-Variable.ttf");
    posterFonts = {
      title: loadFont("BarlowCondensed-Bold.ttf"),
      weekday: loadFont("BarlowCondensed-ExtraBold.ttf"),
      body: instrument.getVariation({ wght: 400, wdth: 100 }),
      venue: instrument.getVariation({ wght: 500, wdth: 100 }),
      brand: instrument.getVariation({ wght: 600, wdth: 100 }),
      mono: loadFont("IBMPlexMono-Regular.ttf"),
      time: loadFont("IBMPlexMono-Medium.ttf"),
      fallbackTitle: noto.getVariation({ wght: 700, wdth: 75 }),
      fallbackBody: noto.getVariation({ wght: 400, wdth: 100 }),
    };
  }
  return posterFonts;
}

export function cleanAgendaText(value: string, limit = 700): string {
  const cleaned = value
    .replace(UNSAFE_CONTROL_CHARACTERS, "")
    .replace(/\s+/g, " ")
    .trim()
    .normalize("NFC");
  if (cleaned.length > limit) {
    throw new AgendaRenderError("Event text exceeds the safe poster layout limit.");
  }
  return cleaned;
}

function hasGlyphs(font: Font, text: string): boolean {
  return Array.from(text).every((character) =>
    font.hasGlyphForCodePoint(character.codePointAt(0)!),
  );
}

// These larger faces are loaded only when the established design fonts cannot
// preserve the complete event identity. Existing Latin/Serbian layouts stay exact.
export function getExtendedFallbackFont(value: string): Font | undefined {
  japaneseFallback ||= loadFont("IPAGothic.ttf");
  if (hasGlyphs(japaneseFallback, value)) return japaneseFallback;
  unicodeFallback ||= loadFont("Unifont.ttf");
  return hasGlyphs(unicodeFallback, value) ? unicodeFallback : undefined;
}

function fontForText(primary: Font, fallback: Font, value: string): Font {
  if (hasGlyphs(primary, value)) return primary;
  if (hasGlyphs(fallback, value)) return fallback;
  const extended = getExtendedFallbackFont(value);
  if (extended) return extended;
  throw new AgendaRenderError("Event text contains unsupported identity characters.");
}

type TextMetrics = {
  width: number;
  minX: number;
  minY: number;
  maxY: number;
  height: number;
};

export function measureAgendaText(font: Font, text: string, size: number, spacing = 0): TextMetrics {
  const run = font.layout(text);
  const scale = size / font.unitsPerEm;
  let cursor = 0;
  let minX = 0;
  let maxX = 0;
  let minY = 0;
  let maxY = 0;
  run.glyphs.forEach((glyph, index) => {
    const position = run.positions[index];
    const bounds = glyph.bbox;
    minX = Math.min(minX, cursor + (position.xOffset + bounds.minX) * scale);
    maxX = Math.max(maxX, cursor + (position.xOffset + bounds.maxX) * scale);
    minY = Math.min(minY, (position.yOffset + bounds.minY) * scale);
    maxY = Math.max(maxY, (position.yOffset + bounds.maxY) * scale);
    cursor += position.xAdvance * scale + (index < run.glyphs.length - 1 ? spacing : 0);
  });
  return {
    width: Math.max(maxX, cursor) - minX,
    minX,
    minY,
    maxY,
    height: maxY - minY,
  };
}

export function outlinedAgendaText(
  value: string,
  font: Font,
  size: number,
  x: number,
  top: number,
  fill: string,
  spacing = 0,
): string {
  const run = font.layout(value);
  const scale = size / font.unitsPerEm;
  const metrics = measureAgendaText(font, value, size, spacing);
  let cursor = x - metrics.minX;
  const baseline = top + metrics.maxY;
  return run.glyphs
    .map((glyph, index) => {
      const position = run.positions[index];
      const data = glyph.path.toSVG();
      const glyphX = cursor + position.xOffset * scale;
      const glyphY = baseline - position.yOffset * scale;
      cursor += position.xAdvance * scale + (index < run.glyphs.length - 1 ? spacing : 0);
      return data
        ? `<path fill="${fill}" d="${data}" transform="translate(${glyphX} ${glyphY}) scale(${scale} ${-scale})"/>`
        : "";
    })
    .join("");
}

// Wrap at measured word boundaries. Long unspaced identities are split across
// lines without deleting characters; a name never becomes an ellipsis.
function wrapText(
  value: string,
  font: Font,
  size: number,
  maxWidth: number,
  spacing = 0,
): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of value.split(" ").filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (measureAgendaText(font, next, size, spacing).width <= maxWidth) {
      line = next;
      continue;
    }
    if (line) {
      lines.push(line);
      line = "";
    }
    for (const character of Array.from(word)) {
      const nextPart = line + character;
      if (measureAgendaText(font, nextPart, size, spacing).width > maxWidth) {
        if (!line) throw new AgendaRenderError("Event text cannot fit the poster width.");
        lines.push(line);
        line = character;
      } else {
        line = nextPart;
      }
    }
  }
  if (line) lines.push(line);
  return lines;
}

export type TextBlock = {
  font: Font;
  size: number;
  spacing: number;
  lines: string[];
  lineHeight: number;
  height: number;
};

function textBlock(
  value: string,
  primary: Font,
  fallback: Font,
  size: number,
  lineHeight: number,
  spacing = 0,
): TextBlock {
  const font = fontForText(primary, fallback, value);
  const lines = wrapText(value, font, size, BODY_WIDTH, spacing);
  return {
    font,
    size,
    spacing,
    lines,
    lineHeight,
    height: lines.length
      ? (lines.length - 1) * lineHeight + Math.max(...lines.map((line) => measureAgendaText(font, line, size, spacing).height))
      : 0,
  };
}

type PosterRow = {
  title: TextBlock;
  venue: TextBlock;
  detail?: TextBlock;
  timeLines: string[];
  bodyHeight: number;
  minHeight: number;
};

function buildRows(events: PreparedAgendaEvent[], fonts: PosterFonts, fourEventReel = false): PosterRow[] {
  const identities = events.map((event) => {
    const title = cleanAgendaText(event.title).toLocaleUpperCase("sr-Latn-RS");
    const venue = cleanAgendaText(event.venue, 300);
    if (!title || !venue) {
      throw new AgendaRenderError("Poster requires complete event and venue identities.");
    }
    return { event, title, venue };
  });

  // First remove optional detail when necessary. Only then reduce the title
  // size. Names and venues are always complete, even for multi-artist lineups.
  for (const showDetails of [true, false]) {
    for (const titleSize of showDetails ? [76] : [76, 72, 68, 64, 60, 56]) {
      const rows = identities.map(({ event, title, venue }) => {
        const titleBlock = textBlock(title, fonts.title, fonts.fallbackTitle, titleSize, titleSize * 0.99, -0.8);
        const venueBlock = textBlock(venue, fonts.venue, fonts.fallbackBody, 43, 49);
        let detail: TextBlock | undefined;
        if (showDetails && event.detail) {
          try {
            const detailText = cleanAgendaText(event.detail, 600);
            const candidate = textBlock(detailText, fonts.body, fonts.fallbackBody, 39, 47);
            if (candidate.lines.length <= 2) detail = candidate;
          } catch (error) {
            if (!(error instanceof AgendaRenderError)) throw error;
          }
        }
        const normalizedTime = cleanAgendaText(event.time ?? "", 72).replaceAll(":", ".");
        const [start, end] = normalizedTime.split(/[-\u2013\u2014]/);
        const timeLines = start ? [start, ...(end ? [`\u2013${end}`] : [])] : ["\u2014"];
        const bodyHeight = titleBlock.height + 18 + venueBlock.height + (detail ? 13 + detail.height : 0);
        return {
          title: titleBlock,
          venue: venueBlock,
          detail,
          timeLines,
          bodyHeight,
          minHeight: fourEventReel ? Math.max(bodyHeight, 108) + 38 : Math.max(bodyHeight, timeLines.length > 1 ? 95 : 44) + ROW_PADDING,
        };
      });
      if (rows.reduce((height, row) => height + row.minHeight, 0) <= (fourEventReel ? REEL_LIST_BOTTOM : LIST_BOTTOM) - LIST_TOP) {
        return rows;
      }
    }
  }
  throw new AgendaRenderError("Complete event identities cannot fit safely on this poster.");
}

export type AgendaLayoutRow = PosterRow & {
  top: number;
  height: number;
  bodyTop: number;
  venueTop: number;
  detailTop: number;
};

export function buildAgendaLayout(events: PreparedAgendaEvent[], options: { format?: "feed" | "story" | "reel" } = {}): AgendaLayoutRow[] {
  if (events.length < 1 || events.length > (options.format === "reel" ? 4 : 3)) {
    throw new AgendaRenderError(options.format === "reel" ? "Reel requires one to four events." : "Poster requires one to three events.");
  }
  const fourEventReel = options.format === "reel" && events.length === 4;
  const rows = buildRows(events, getAgendaFonts(), fourEventReel);
  const extra = ((fourEventReel ? REEL_LIST_BOTTOM : LIST_BOTTOM) - LIST_TOP - rows.reduce((height, row) => height + row.minHeight, 0)) / rows.length;
  let rowTop = LIST_TOP;
  return rows.map((row) => {
    const height = row.minHeight + extra;
    const bodyTop = rowTop + (height - row.bodyHeight) / 2;
    const venueTop = bodyTop + row.title.height + 18;
    const detailTop = venueTop + row.venue.height + 13;
    const layout = { ...row, top: rowTop, height, bodyTop, venueTop, detailTop };
    rowTop += height;
    return layout;
  });
}

export function getAgendaTagPositions(events: PreparedAgendaEvent[]): Array<{ x: number; y: number }> {
  return buildAgendaLayout(events).map((row) => {
    const venueWidth = Math.max(...row.venue.lines.map((line) =>
      measureAgendaText(row.venue.font, line, row.venue.size).width,
    ));
    return {
      x: Number(((BODY_X + venueWidth / 2) / WIDTH).toFixed(4)),
      y: Number(((row.venueTop + row.venue.height / 2) / HEIGHT).toFixed(4)),
    };
  });
}
