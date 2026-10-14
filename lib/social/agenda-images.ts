import sharp from "sharp";
import {
  AgendaRenderError,
  BODY_X,
  HEIGHT,
  LIST_BOTTOM,
  MARGIN,
  WIDTH,
  buildAgendaLayout,
  cleanAgendaText,
  getAgendaFonts,
  measureAgendaText,
  outlinedAgendaText,
  type TextBlock,
} from "./agenda-layout.ts";
import {
  formatAgendaDate,
  getAgendaEventDetail,
  getAgendaEventTime,
  type DailyCarouselEvent,
} from "./daily-carousel.ts";

export { AgendaRenderError } from "./agenda-layout.ts";

export type AgendaPosterInput = {
  date: string;
  events: DailyCarouselEvent[];
  position: number;
};

const PALETTES = [
  { background: "#050609", text: "#F7F8F8", accent: "#8B86FB" },
  { background: "#F7F8F8", text: "#050609", accent: "#050609" },
  { background: "#8B86FB", text: "#050609", accent: "#F7F8F8" },
] as const;

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function renderBlock(block: TextBlock, top: number, fill: string, opacity = 1): string {
  return `<g opacity="${opacity}">${block.lines.map((line, index) =>
    outlinedAgendaText(line, block.font, block.size, BODY_X, top + index * block.lineHeight, fill, block.spacing),
  ).join("")}</g>`;
}

export function buildAgendaPosterSvg(input: AgendaPosterInput): Buffer {
  if (!Number.isInteger(input.position) || input.position < 0 || input.position > 2) {
    throw new AgendaRenderError("Poster position must be between zero and two.");
  }
  if (input.events.some((event) => event.date !== input.date)) {
    throw new AgendaRenderError("Poster events must share its exact date.");
  }
  const date = formatAgendaDate(input.date);
  const fonts = getAgendaFonts();
  const palette = PALETTES[input.position];
  const rows = buildAgendaLayout(input.events.map((event) => ({
    title: event.title,
    venue: event.venue,
    time: getAgendaEventTime(event),
    detail: getAgendaEventDetail(event),
  })));
  const rowSvg = rows.map((row) => {
    const title = renderBlock(row.title, row.bodyTop, palette.text);
    const venue = renderBlock(row.venue, row.venueTop, palette.text);
    const detail = row.detail ? renderBlock(row.detail, row.detailTop, palette.text, 0.87) : "";
    const time = row.timeLines.map((line, index) =>
      outlinedAgendaText(line, fonts.time, index ? 38 : 44, MARGIN, row.bodyTop + index * 53 + 3, palette.text),
    ).join("");
    return `<path d="M${MARGIN} ${row.top}H${WIDTH - MARGIN}" stroke="${palette.text}" stroke-width="3"/>${time}${title}${venue}${detail}`;
  }).join("");
  const weekday = date.weekday.toLocaleUpperCase("sr-Latn-RS");
  const weekdaySize = Math.min(176, 176 * (WIDTH - 2 * MARGIN) / measureAgendaText(fonts.weekday, weekday, 176, -3).width);
  const website = "eventzeka.com";
  const websiteSize = 34;
  const websiteWidth = measureAgendaText(fonts.mono, website, websiteSize).width;
  const footerSvg = `
    <path d="M${MARGIN} ${LIST_BOTTOM}H${WIDTH - MARGIN}" stroke="${palette.text}" stroke-width="3"/>
    <g transform="translate(62 1252) scale(1.75)" fill="none" stroke="${palette.text}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
      <path d="M13 16a3 3 0 0 1 2.24 5M18 12h.01M18 21c1.5 0 3-.8 3-2s-1-2-3-2c0-3 1-5-1-7-1.5-1.5-2-1-3-1-1 0-2 1-2 1s-1.5-1-2-3c-.7-2.7-2.1-4-3-3s-.4 3.6.2 4.8C7.8 10 8.5 11 8.5 11s-2.3 1-3.5 3c-.7 1.2-1 2.3-1 3.5C4 19.7 6.3 21 9 21h9Z"/>
    </g>
    ${outlinedAgendaText("event zeka", fonts.brand, 36, 121, 1255, palette.text, -1)}
    ${outlinedAgendaText("Izbor doga\u0111aja", fonts.mono, 30, 422, 1258, palette.text)}
    ${outlinedAgendaText(website, fonts.mono, websiteSize, WIDTH - MARGIN - websiteWidth, 1255, palette.text)}`;

  // External values only enter escaped accessibility metadata or measured
  // outlines. No event can inject an SVG element, attribute, URL or stylesheet.
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img">
    <title>${escapeXml(`${date.weekday}, ${date.dateLabel} Event Zeka`)}</title>
    <desc>${escapeXml(input.events.map((event) => `${cleanAgendaText(event.title)}; ${cleanAgendaText(event.venue)}; ${getAgendaEventTime(event) || "satnica nije objavljena"}`).join(". "))}</desc>
    <rect width="${WIDTH}" height="${HEIGHT}" fill="${palette.background}"/>
    ${outlinedAgendaText("BEOGRAD", fonts.mono, 36, MARGIN, 69, palette.text)}
    ${outlinedAgendaText(`${input.position + 1} / 3`, fonts.mono, 36, 910, 69, palette.text)}
    ${outlinedAgendaText(weekday, fonts.weekday, weekdaySize, MARGIN, 147, palette.text, -3)}
    ${outlinedAgendaText(date.dateLabel, fonts.venue, 54, MARGIN, 313, palette.accent)}
    ${rowSvg}${footerSvg}
  </svg>`);
}

export async function renderAgendaPoster(input: AgendaPosterInput): Promise<Buffer> {
  return sharp(buildAgendaPosterSvg(input), { limitInputPixels: 2_000_000 })
    .jpeg({ quality: 93, chromaSubsampling: "4:4:4" })
    .toBuffer();
}
