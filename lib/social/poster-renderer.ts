import { readFileSync } from "node:fs";
import path from "node:path";
import type { Font } from "fontkit";
import { AgendaRenderError, cleanAgendaText, getAgendaFonts, measureAgendaText, outlinedAgendaText, type TextBlock } from "./agenda-layout.ts";
import { buildPosterLayout, getPosterFonts, posterFont, POSTER_TIME_FRAME, type PosterDirection, type PosterRow } from "./poster-layout.ts";
import { getPosterDirection, type PosterFormat } from "./poster-directions.ts";
import { formatAgendaDate, getAgendaEventDetail, getAgendaEventTime, getNextIsoDate, type DailyCarouselEvent } from "./daily-carousel.ts";
import { CLOSING_CTA_COPY } from "./carousel-cta.ts";

export type PosterInput = { date: string; events: DailyCarouselEvent[]; position: number; format?: PosterFormat; publishDate?: string };
export type PosterTextBounds = { role: string; text: string; x: number; y: number; width: number; height: number };
const artCache = new Map<string, string>();
const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const rect = (x: number, y: number, w: number, h: number, fill: string, extra = "") => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" ${extra}/>`;
function paper(x: number, y: number, w: number, h: number, fill: string, opacity = 1) {
  const points = Array.from({ length: 9 }, (_, i) => `${x + w - (i % 2 ? 6 : 0)},${y + i * h / 8}`).join("L");
  return `<path d="M${x + 4} ${y + 2}L${x + w - 3} ${y}L${points}L${x + 1} ${y + h - 2}L${x} ${y + 12}Z" fill="${fill}" opacity="${opacity}"/>`;
}
function artworkData(theme: PosterDirection) {
  const filename = `${theme.id}-${theme.key}.jpg`;
  if (!artCache.has(filename)) artCache.set(filename, readFileSync(path.join(process.cwd(), "public/social/art-directions", filename)).toString("base64"));
  return artCache.get(filename)!;
}
export function background(theme: PosterDirection, height: number) {
  const image = artworkData(theme);
  if (theme.compositionStyle === "material") {
    const expanded = theme.composition === 2;
    const x = expanded ? -84 : 0, y = expanded ? -100 : 0, w = expanded ? 1248 : 1080, h = expanded ? height + 200 : height;
    const artwork = `<image href="data:image/jpeg;base64,${image}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="${expanded ? "xMaxYMid" : "xMidYMid"} slice"/>`;
    return rect(0, 0, 1080, height, theme.bg) + (theme.composition === 1 ? `<g transform="translate(1080 0) scale(-1 1)">${artwork}</g>` : artwork);
  }
  const align = theme.composition === 1 ? "xMinYMid" : theme.composition === 2 ? "xMaxYMid" : "xMidYMid";
  return rect(0, 0, 1080, height, theme.bg) + `<image href="data:image/jpeg;base64,${image}" width="1080" height="${height}" preserveAspectRatio="${align} slice"/>`;
}
function makeTypography(bounds: PosterTextBounds[], theme: PosterDirection) {
  function text(value: string, font: Font, size: number, x: number, y: number, fill: string, role: string) {
    font = posterFont(font, value, role === "detail" || role === "venue");
    const m = measureAgendaText(font, value, size);
    bounds.push({ role, text: value, x, y, width: m.width, height: m.height });
    const readingSurface = theme.compositionStyle === "material" && role === "heading"
      ? `<defs><filter id="quiet-${bounds.length}" x="-30%" y="-80%" width="160%" height="260%"><feGaussianBlur stdDeviation="12"/></filter></defs>${rect(x - 12, y - 9, m.width + 32, m.height + 20, theme.bg, `opacity=".88" filter="url(#quiet-${bounds.length})"`)}`
      : "";
    return readingSurface + `<g data-role="${role}" aria-label="${escape(value)}">${outlinedAgendaText(value, font, size, x, y, fill)}</g>`;
  }
  function fit(value: string, font: Font, max: number, min: number, x: number, y: number, width: number, fill: string, role: string, maxHeight = Infinity) {
    font = posterFont(font, value);
    for (let size = max; size >= min; size--) {
      const m = measureAgendaText(font, value, size);
      if (m.width <= width && m.height <= maxHeight) return { svg: text(value, font, size, x, y, fill, role), bottom: y + m.height, width: m.width, height: m.height };
    }
    throw new AgendaRenderError("Complete heading cannot fit safely.");
  }
  function block(value: TextBlock, x: number, top: number, fill: string, role: string) {
    return value.lines.map((line, i) => text(line, value.font, value.size, x, top + i * value.lineHeight, fill, role)).join("");
  }
  return { text, fit, block };
}
const rabbit = (x: number, y: number, color: string) => `<g transform="translate(${x} ${y}) scale(1.7)" stroke="${color}" stroke-width="1.9" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M13 16a3 3 0 0 1 2.24 5M18 12h.01M18 21c1.5 0 3-.8 3-2s-1-2-3-2c0-3 1-5-1-7-1.5-1.5-2-1-3-1-1 0-2 1-2 1s-1.5-1-2-3c-.7-2.7-2.1-4-3-3s-.4 3.6.2 4.8C7.8 10 8.5 11 8.5 11s-2.3 1-3.5 3c-.7 1.2-1 2.3-1 3.5C4 19.7 6.3 21 9 21h9Z"/></g>`;
const darkPanels = new Set(["night", "heat", "tribal", "redprint", "laser", "bio", "signal"]);
function materialEventPanel(theme: PosterDirection, row: PosterRow, i: number) {
  const { x, top: y, width: w, height: h } = row, fill = theme.rowFills?.[i], accent = theme.colors[i];
  if (!fill) throw new AgendaRenderError("Material artwork requires a reading surface for every event.");
  const dark = darkPanels.has(theme.panel), id = `material-${i}`;
  const image = artworkData(theme), offset = (i * 113 + theme.composition * 91) % (h * 3);
  let s = rect(x + 4, y + 6, w, h, theme.dark, 'opacity=".16"');
  s += `<defs><clipPath id="${id}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="2"/></clipPath></defs>`;
  s += `<g class="event-pattern" data-pattern="${theme.key}-${theme.composition}-${i}" clip-path="url(#${id})">`;
  s += rect(x, y, w, h, fill);
  s += `<image href="data:image/jpeg;base64,${image}" x="${x}" y="${y - offset}" width="${w}" height="${h * 4}" preserveAspectRatio="xMidYMid slice" opacity="${dark ? ".23" : ".17"}"/>`;
  s += rect(row.bodyX - 10, y + 13, w - 236, h - 26, fill, 'opacity=".92"');
  s += rect(x, y, 4, h, dark ? accent : theme.dark, 'opacity=".8"');
  if (theme.panel === "tribal") s += `<path d="M${x + w - 34} ${y + 2}l25 5-13 6 18 3M${x + 2} ${y + h - 20}l13 5-7 11" fill="none" stroke="${accent}" stroke-width="2"/>`;
  else if (theme.panel === "xerox") s += rect(x + 18, y + 2, w - 43, 3, theme.accent, 'opacity=".65"') + rect(x + w - 12, y + 12, 6, h - 24, theme.dark, 'opacity=".3"');
  else if (theme.panel === "heat") s += `<path d="M${x + 14} ${y + 5}H${x + w - 18}M${x + w - 17} ${y + 10}V${y + h - 10}" stroke="${accent}" stroke-width="1" opacity=".6"/>`;
  else if (theme.panel === "collage") s += rect(x + w - 76, y + 1, 60, 12, theme.paper, 'opacity=".7"') + rect(x + 7, y + h - 9, 50, 5, theme.accent, 'opacity=".5"');
  else s += `<path d="M${x + 18} ${y + 3}H${x + w - 18}M${x + 18} ${y + h - 3}H${x + w - 18}" stroke="${accent}" stroke-width="1" opacity=".45"/>`;
  return s + "</g>";
}
export function eventPanel(theme: PosterDirection, row: PosterRow, i: number) {
  if (theme.compositionStyle === "material") return materialEventPanel(theme, row, i);
  const { x, top: y, width: w, height: h } = row, color = theme.colors[i], ink = theme.dark;
  let s = "";
  if (theme.panel === "riso") s = rect(x + 5, y + 7, w, h, theme.dark, 'opacity=".3"') + rect(x, y, w, h, color) + `<path d="M${x + 3} ${y + 4}H${x + w - 2}M${x + 1} ${y + h - 2}H${x + w - 10}" stroke="${ink}" stroke-width="2" stroke-dasharray="2 5" opacity=".45"/>`;
  else if (darkPanels.has(theme.panel)) {
    s = rect(x, y, w, h, theme.dark) + rect(x, y, theme.panel === "tribal" ? 3 : 5, h, color);
    s += `<path d="M${x + 20} ${y + h}H${x + w}" stroke="${color}" stroke-opacity=".6"/>`;
    if (theme.panel === "tribal") s += `<path d="M${x + w - 34} ${y}l20 10-8 22M${x} ${y + h - 25}l13 10-5 15" stroke="${color}" fill="none" stroke-width="2"/>`;
    if (theme.panel === "laser") s += rect(x + 1, y + 1, w - 2, h - 2, "none", `stroke="${theme.accent}" stroke-opacity=".65"`);
  } else if (theme.panel === "botanical") s = paper(x + 4, y + 6, w, h, ink, .2) + paper(x, y, w, h, color) + `<path d="M${x + w - 23} ${y + 2}l-3 24 21-4" fill="${ink}" opacity=".12"/>`;
  else if (theme.panel === "ticket") {
    s = rect(x + 6, y + 7, w, h, theme.accent) + rect(x, y, w, h, ink) + rect(x + 5, y + 5, w - 10, h - 10, color) + rect(x + 12, y + 12, w - 24, h - 24, "none", `stroke="${ink}" stroke-width="2"`);
    for (const xx of [x, x + w]) s += `<circle cx="${xx}" cy="${y + h / 2}" r="10" fill="${theme.bg}"/>`;
    const divider = row.flip ? x + w - 208 : x + 208;
    s += `<path d="M${divider} ${y + 22}V${y + h - 22}" stroke="${ink}" stroke-opacity=".45" stroke-dasharray="3 6"/>`;
  } else if (theme.panel === "sleeve") s = rect(x + 5, y + 6, w, h, ink, 'opacity=".18"') + rect(x, y, w, h, color) + rect(x, y, 10, h, ink);
  else if (theme.panel === "picnic") s = `<path d="M${x + 10} ${y}H${x + w - 10}V${y + 10}H${x + w}V${y + h - 10}H${x + w - 10}V${y + h}H${x + 10}V${y + h - 10}H${x}V${y + 10}H${x + 10}Z" fill="${color}" stroke="${ink}" stroke-width="2.5"/>`;
  else s = paper(x, y, w, h, color) + `<path d="M${x + 18} ${y + 13}H${x + w - 20}" stroke="${ink}" opacity=".35"/>`;
  const edgeColor = darkPanels.has(theme.panel) ? color : ink;
  s += `<g class="event-pattern" data-pattern="${theme.key}-${theme.composition}-${i}" opacity=".3">`;
  for (let n = 0; n < 10; n++) {
    const px = x + w - 16, py = y + 16 + n * 14;
    s += (n + i + theme.composition) % 3 === 0 ? `<circle cx="${px + 3}" cy="${py + 3}" r="2" fill="${edgeColor}"/>` : rect(px, py, 5, (n + i) % 2 ? 2 : 6, edgeColor);
  }
  return s + "</g>";
}
function timeFrame(theme: PosterDirection, row: PosterRow, i: number, typography: ReturnType<typeof makeTypography>) {
  const dark = darkPanels.has(theme.panel), color = theme.colors[i], ink = dark ? theme.dark : color;
  const { width, height, fontSize, radius } = POSTER_TIME_FRAME, fonts = getAgendaFonts();
  let s = `<g class="time-label">${rect(row.timeX, row.timeY, width, height, dark ? color : theme.dark, `rx="${radius}"`)}`;
  const m = row.timeLines.map(line => measureAgendaText(fonts.time, line, fontSize));
  const heightOfText = m.reduce((n, v) => n + v.height, 0) + (m.length - 1) * 12;
  let top = row.timeY + (height - heightOfText) / 2;
  row.timeLines.forEach((line, index) => { s += typography.text(line, fonts.time, fontSize, row.timeX + (width - m[index].width) / 2, top, ink, "time"); top += m[index].height + 12; });
  return s + "</g>";
}
export function assertPosterTextBounds(bounds: PosterTextBounds[], format: PosterFormat) {
  const vertical = format !== "feed";
  for (const b of bounds) {
    if (b.x < 48 || b.x + b.width > (vertical ? 938 : 1030) || b.y < (vertical ? 226 : 0) || b.y + b.height > (vertical ? 1560 : 1330)) throw new AgendaRenderError(`Text exceeds the poster safe area (${b.role}).`);
  }
  for (let i = 0; i < bounds.length; i++) for (let j = i + 1; j < bounds.length; j++) {
    const a = bounds[i], b = bounds[j];
    if (a.x < b.x + b.width - 1 && b.x < a.x + a.width - 1 && a.y < b.y + b.height - 1 && b.y < a.y + a.height - 1) throw new AgendaRenderError(`Poster text overlaps (${a.role}, ${b.role}).`);
  }
}
export function posterSvg(body: string, height: number, theme: PosterDirection, description = "") {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="${height}" viewBox="0 0 1080 ${height}" role="img" data-theme="${theme.id}" data-composition="${theme.composition}" data-sequence="${theme.sequence}"><title>Event Zeka</title><desc>${escape(description)}</desc>${body}</svg>`;
}
export function buildPosterArtwork(input: PosterInput) {
  if (input.events.some(event => event.date !== input.date)) throw new AgendaRenderError("Poster events must share its exact date.");
  const layout = buildPosterLayout(input.events.map(event => ({ title: event.title, venue: event.venue, time: getAgendaEventTime(event), detail: getAgendaEventDetail(event) })), { ...input, format: input.format });
  const { theme, rows, height, format } = layout, vertical = format !== "feed", fonts = getAgendaFonts(), artFonts = getPosterFonts();
  const bounds: PosterTextBounds[] = [], typography = makeTypography(bounds, theme), { text, fit, block } = typography;
  const top = vertical ? 242 : 56, date = formatAgendaDate(input.date);
  let base = background(theme, height) + (theme.compositionStyle === "material" && theme.composition === 1 ? rect(48, top - 14, 260, 56, theme.bg, 'opacity=".9"') : "") + rabbit(56, top - 7, theme.ink) + text("event zeka", fonts.brand, 27, 109, top, theme.ink, "brand");
  const meta = vertical ? "BEOGRAD" : `BEOGRAD / ${String(input.position + 1).padStart(2, "0")}/04`, mx = vertical ? 770 : 777;
  base += rect(mx - 10, top - 5, measureAgendaText(fonts.mono, meta, 22).width + 20, 33, theme.dark) + text(meta, fonts.mono, 22, mx, top + 2, theme.paper, "meta");
  const heading = format === "story" ? "DANAS" : format === "reel" ? "SUTRA" : date.weekday.toLocaleUpperCase("sr-Latn");
  const maxSize = theme.display === "bodoni" ? 181 : theme.display === "barlow" ? 170 : vertical ? 152 : 126;
  const hero = fit(heading, artFonts[theme.display], maxSize, 56, 61, top + 65, vertical ? 744 : 850, theme.ink, "heading", vertical ? 132 : 116);
  if (["picnic", "sunday"].includes(theme.panel) || (["botanical", "sleeve", "haze"].includes(theme.panel) && hero.width > 600)) base += paper(56, top + 54, hero.width + 28, hero.height + 25, theme.panel === "picnic" ? "#f8e592" : ["sunday", "haze"].includes(theme.panel) ? theme.bg : theme.paper, .98);
  base += hero.svg;
  const dateText = vertical ? `${date.weekday} / ${date.dateLabel}` : date.dateLabel, dy = vertical ? 465 : 274;
  const dateFontSize = vertical ? 27 : 29;
  base += paper(62, dy - 8, measureAgendaText(fonts.mono, dateText, dateFontSize).width + 30, 47, theme.paper) + text(dateText, fonts.mono, dateFontSize, 76, dy + 2, theme.dark, "date");
  const fy = vertical ? 1513 : 1234;
  base += rect(64, fy - 10, vertical ? 862 : 956, 51, theme.dark) + text("@eventzeka", fonts.mono, vertical ? 24 : 25, 80, fy + 3, theme.paper, "footer");
  if (format === "feed") base += text(input.position === 2 ? "Prelistaj za još događaja →" : "Prelistaj za sledeći dan →", fonts.body, 26, 638, fy + 3, theme.paper, "footer");
  else if (format === "reel") base += text("eventzeka.com", fonts.mono, 25, 690, fy + 3, theme.paper, "footer");
  else base += text("BEOGRAD / DANAS", fonts.mono, 23, 678, fy + 4, theme.paper, "footer");
  const bands = rows.map((row, i) => {
    const ink = darkPanels.has(theme.panel) ? theme.ink : theme.dark;
    return eventPanel(theme, row, i) + timeFrame(theme, row, i, typography) + block(row.title, row.bodyX, row.bodyTop, ink, "event-title") + block(row.venue, row.bodyX, row.venueTop, ink, "venue") + (row.detail ? block(row.detail, row.bodyX, row.detailTop, ink, "detail") : "");
  });
  assertPosterTextBounds(bounds, format);
  const description = `${date.weekday}, ${date.dateLabel}. ` + input.events.map(event => `${cleanAgendaText(event.title)}; ${cleanAgendaText(event.venue)}; ${getAgendaEventTime(event) || "satnica nije objavljena"}`).join(". ");
  return { ...layout, bounds, baseSvg: posterSvg(base, height, theme), rowSvgs: bands.map(band => posterSvg(band, height, theme)), svg: Buffer.from(posterSvg(base + bands.join(""), height, theme, description)) };
}
export function buildPosterClosing(publishDate = "2000-01-01") {
  const theme = getPosterDirection(getNextIsoDate(publishDate), 0, "feed", publishDate), fonts = getAgendaFonts(), display = getPosterFonts()[theme.display];
  const bounds: PosterTextBounds[] = [], { text, fit } = makeTypography(bounds, theme);
  let body = background(theme, 1350) + (theme.quietClosingLabels ? rect(52, 44, 270, 58, theme.bg, 'opacity=".94" data-role="closing-reading-surface" data-label="brand"') : "") + text("event zeka", fonts.brand, 28, 64, 60, theme.ink, "brand") + rect(870, 52, 136, 42, theme.dark) + text("04 / 04", fonts.mono, 25, 883, 61, theme.paper, "meta");
  const first = fit("Zeka", display, 270, 180, 62, 312, 830, theme.ink, "heading");
  const last = fit("zna.", display, 270, 180, 62, first.bottom + 38, 830, theme.ink, "heading");
  if (last.bottom > 866) throw new AgendaRenderError("Closing heading cannot fit safely.");
  if (["ticket", "sleeve", "picnic", "haze"].includes(theme.panel)) {
    const lightInk = [1, 3, 5].reduce((sum, i) => sum + parseInt(theme.ink.slice(i, i + 2), 16), 0) > 480;
    body += paper(52, 296, Math.max(first.width, last.width) + 30, last.bottom - 280, lightInk ? theme.dark : theme.paper, .98);
  }
  body += first.svg + last.svg + paper(62, 906, 956, 274, theme.colors[0]);
  body += text(CLOSING_CTA_COPY.action, fonts.body, 42, 92, 949, theme.dark, "cta") + fit(CLOSING_CTA_COPY.benefit, fonts.brand, 81, 70, 88, 1025, 875, theme.dark, "cta").svg;
  body += (theme.quietClosingLabels ? rect(53, 1224, measureAgendaText(fonts.body, "Za sledeći izlazak.", 29).width + 24, 56, theme.bg, 'opacity=".94" data-role="closing-reading-surface" data-label="footer"') : "") + text("Za sledeći izlazak.", fonts.body, 29, 65, 1235, theme.ink, "footer");
  assertPosterTextBounds(bounds, "feed");
  return { theme, bounds, svg: Buffer.from(posterSvg(body, 1350, theme, `${CLOSING_CTA_COPY.title} ${CLOSING_CTA_COPY.action} ${CLOSING_CTA_COPY.benefit}`)) };
}
