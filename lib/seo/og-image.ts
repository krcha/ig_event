import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { create, type Font } from "fontkit";
import sharp from "sharp";
import { isLocale, localizeHref, LOCALE_LANGUAGE_TAGS, type Locale } from "../../i18n/config.ts";
import { measureAgendaText, outlinedAgendaText } from "../social/agenda-layout.ts";

export const OG_IMAGE_DESIGN_VERSION = "eventzeka-dark-lime-localized-v1";
export const OG_IMAGE_SIZE = { width: 1200, height: 630 } as const;
export const OG_IMAGE_MAX_BYTES = 1_000_000;

const COPY = {
  sr: {
    headline: ["Dešavanja", "u Beogradu."],
    description: ["Žurke, koncerti i kultura.", "Pronađi svoj sledeći izlazak."],
  },
  en: {
    headline: ["Belgrade events,", "happening now."],
    description: ["Nightlife, live music and culture.", "Find your next night out."],
  },
  ru: {
    headline: ["События", "в Белграде."],
    description: ["Вечеринки, концерты и культура.", "Найдите событие по душе."],
  },
} satisfies Record<Locale, { headline: string[]; description: string[] }>;

export function getOgImageCopy(locale: Locale) {
  return { ...COPY[locale], url: `eventzeka.com${localizeHref("/", locale) === "/" ? "" : localizeHref("/", locale)}` };
}

type OgFonts = { bold: Font; regular: Font; fallbackBold: Font; fallbackRegular: Font };
let fonts: OgFonts | undefined;

function loadFont(filename: string): Font {
  const font = create(readFileSync(path.join(process.cwd(), "public", "fonts", filename)));
  if (!("layout" in font)) throw new Error("Open Graph font requires a single face.");
  return font;
}

function getFonts(): OgFonts {
  if (!fonts) {
    const fallback = loadFont("social/NotoSans-Variable.ttf");
    fonts = {
      bold: loadFont("space-grotesk-700.woff2"),
      regular: loadFont("space-grotesk-400.woff2"),
      fallbackBold: fallback.getVariation({ wght: 700, wdth: 100 }),
      fallbackRegular: fallback.getVariation({ wght: 400, wdth: 100 }),
    };
  }
  return fonts;
}

function fontFor(text: string, bold = false): Font {
  const faces = getFonts();
  const candidates = bold ? [faces.bold, faces.fallbackBold] : [faces.regular, faces.fallbackRegular];
  const font = candidates.find((candidate) => Array.from(text).every((letter) => candidate.hasGlyphForCodePoint(letter.codePointAt(0)!)));
  if (!font) throw new Error("Open Graph text contains unsupported characters.");
  return font;
}

export function buildOgImageSvg(locale: Locale): string {
  const copy = getOgImageCopy(locale);
  const text = (value: string, size: number, x: number, top: number, color = "#F4F2EB", bold = false) =>
    outlinedAgendaText(value, fontFor(value, bold), size, x, top, color);
  let headlineSize = 82;
  while (headlineSize > 60 && copy.headline.some((line) => measureAgendaText(fontFor(line, true), line, headlineSize).width > 730)) headlineSize -= 2;
  if (copy.headline.some((line) => measureAgendaText(fontFor(line, true), line, headlineSize).width > 730)) {
    throw new Error("Open Graph heading exceeds its bounded layout.");
  }
  for (const line of copy.description) {
    if (measureAgendaText(fontFor(line), line, 29).width > 730) throw new Error("Open Graph description exceeds its bounded layout.");
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
    <rect width="1200" height="630" fill="#10141F"/>
    <rect x="64" y="62" width="250" height="64" rx="32" fill="#D5F56B"/>
    <g transform="translate(81 73) scale(.8)">
      <ellipse cx="17.5" cy="13" fill="#10141F" rx="5" ry="11" transform="rotate(-16 17.5 13)"/>
      <ellipse cx="30.5" cy="13" fill="#10141F" rx="5" ry="11" transform="rotate(16 30.5 13)"/>
      <circle cx="24" cy="29" fill="#10141F" r="13"/>
      <circle cx="19.25" cy="27" fill="#D5F56B" r="1.35"/><circle cx="28.75" cy="27" fill="#D5F56B" r="1.35"/>
      <path d="M22 32.2c1.1 1.35 2.9 1.35 4 0" fill="none" stroke="#D5F56B" stroke-linecap="round" stroke-width="1.8"/>
    </g>
    ${text("Event Zeka", 30, 132, 81, "#10141F", true)}
    ${copy.headline.map((line, index) => text(line, headlineSize, 64, 198 + index * 102, "#F4F2EB", true)).join("")}
    ${copy.description.map((line, index) => text(line, 29, 68, 426 + index * 43, "#A8B0C2")).join("")}
    ${text(copy.url, 24, 68, 561, "#D5F56B")}
    <g transform="translate(897 154) scale(.7)">
      <ellipse cx="115" cy="96" fill="#D5F56B" rx="38" ry="92" transform="rotate(-16 115 96)"/>
      <ellipse cx="245" cy="96" fill="#D5F56B" rx="38" ry="92" transform="rotate(16 245 96)"/>
      <circle cx="180" cy="265" fill="#D5F56B" r="142"/>
      <circle cx="130" cy="245" fill="#10141F" r="14"/><circle cx="230" cy="245" fill="#10141F" r="14"/>
      <path d="M158 302c12 16 32 16 44 0" fill="none" stroke="#10141F" stroke-linecap="round" stroke-width="17"/>
    </g>
  </svg>`;
}

export async function renderOgImage(locale: Locale): Promise<Buffer> {
  const image = await sharp(Buffer.from(buildOgImageSvg(locale)), { limitInputPixels: 1_000_000 })
    .png().timeout({ seconds: 8 }).toBuffer();
  if (image.length > OG_IMAGE_MAX_BYTES) throw new Error("Open Graph image exceeded its byte budget.");
  return image;
}

/** Exactly three possible immutable brand images; concurrent requests coalesce. */
export function createLocalizedOgRenderer(render: (locale: Locale) => Promise<Buffer> = renderOgImage) {
  const entries = new Map<Locale, Promise<Buffer>>();
  return (locale: Locale): Promise<Buffer> => {
    if (!isLocale(locale)) return Promise.reject(new Error("Unsupported image language."));
    const cached = entries.get(locale);
    if (cached) return cached;
    const pending = render(locale).then((bytes) => {
      if (bytes.length > OG_IMAGE_MAX_BYTES) throw new Error("Open Graph image exceeded its byte budget.");
      return bytes;
    }).catch((error) => { entries.delete(locale); throw error; });
    entries.set(locale, pending);
    return pending;
  };
}

const cachedOgImage = createLocalizedOgRenderer();

export function createOgImageHandler(options: { fixedLocale?: Locale; render?: (locale: Locale) => Promise<Buffer> } = {}) {
  return async (request: Request): Promise<Response> => {
    const requested = new URL(request.url).searchParams.getAll("locale");
    const locale = options.fixedLocale ?? requested[0] ?? "sr";
    if (!isLocale(locale) || (!options.fixedLocale && requested.length > 1)) {
      return new Response("Unsupported image language.", { status: 400, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
    }
    try {
      const image = await (options.render ?? cachedOgImage)(locale);
      const etag = `"${createHash("sha256").update(OG_IMAGE_DESIGN_VERSION).update(image).digest("hex")}"`;
      const headers = {
        "cache-control": "public, max-age=3600, s-maxage=86400",
        "content-language": LOCALE_LANGUAGE_TAGS[locale],
        "x-content-type-options": "nosniff",
        etag,
      };
      if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
      return new Response(request.method === "HEAD" ? null : new Uint8Array(image), {
        headers: { ...headers, "content-type": "image/png", "content-length": String(image.length) },
      });
    } catch {
      return new Response("Could not prepare this image.", { status: 503, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
    }
  };
}
