import sharp from "sharp";

const SLIDE_WIDTH = 1080;
const SLIDE_HEIGHT = 1350;
const SERBIAN_MONTHS = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAJ",
  "JUN",
  "JUL",
  "AVG",
  "SEP",
  "OKT",
  "NOV",
  "DEC",
];

export type EventCarouselSlideInput = {
  poster?: Buffer | null;
  title: string;
  venue: string;
  instagramHandle: string;
  date: string;
  time?: string;
};

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function wrapText(value: string, maxCharacters: number, maxLines: number): string[] {
  const words = compactText(value).split(" ").filter(Boolean);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= maxCharacters || !current) {
      current = next;
      continue;
    }
    lines.push(current);
    current = word;
    if (lines.length === maxLines - 1) {
      break;
    }
  }

  if (current && lines.length < maxLines) {
    const consumed = lines.join(" ").split(" ").filter(Boolean).length;
    const remainder = words.slice(consumed).join(" ");
    const line = remainder || current;
    lines.push(line.length > maxCharacters ? `${line.slice(0, maxCharacters - 1).trimEnd()}…` : line);
  }
  return lines.slice(0, maxLines);
}

function formatDateLabel(date: string, time?: string): string {
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const dateLabel = match
    ? `${Number.parseInt(match[3], 10)}. ${SERBIAN_MONTHS[Number.parseInt(match[2], 10) - 1]}`
    : date;
  const normalizedTime = time?.trim() ?? "";
  return normalizedTime && normalizedTime.toUpperCase() !== "TBD"
    ? `${dateLabel} • ${normalizedTime}`
    : dateLabel;
}

function eventOverlaySvg(input: EventCarouselSlideInput): Buffer {
  const titleLines = wrapText(input.title, 29, 2);
  const titleText = titleLines
    .map(
      (line, index) =>
        `<text x="72" y="${1055 + index * 66}" fill="#F7F8F8" font-family="DejaVu Sans, Arial, sans-serif" font-size="58" font-weight="700" letter-spacing="-1">${escapeXml(line)}</text>`,
    )
    .join("");
  const venue = compactText(input.venue);
  const handle = input.instagramHandle.trim().replace(/^@+/, "").toLowerCase();

  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${SLIDE_WIDTH}" height="${SLIDE_HEIGHT}">
    <defs>
      <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#050609" stop-opacity="0"/>
        <stop offset="0.2" stop-color="#050609" stop-opacity="0.78"/>
        <stop offset="0.48" stop-color="#050609" stop-opacity="0.97"/>
        <stop offset="1" stop-color="#050609"/>
      </linearGradient>
      <linearGradient id="pill" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#B4B1FF"/>
        <stop offset="1" stop-color="#7C76F2"/>
      </linearGradient>
    </defs>
    <rect x="0" y="0" width="1080" height="1350" fill="url(#fade)"/>
    <g transform="translate(48 42)">
      <rect width="360" height="78" rx="39" fill="#090B12" fill-opacity="0.94" stroke="#8B86FB" stroke-width="2"/>
      <ellipse cx="45" cy="23" rx="9" ry="20" transform="rotate(-12 45 23)" fill="#A6A2FF"/>
      <ellipse cx="68" cy="23" rx="9" ry="20" transform="rotate(12 68 23)" fill="#A6A2FF"/>
      <circle cx="57" cy="44" r="23" fill="#8B86FB"/>
      <text x="98" y="50" fill="#F7F8F8" font-family="DejaVu Sans, Arial, sans-serif" font-size="27" font-weight="700" letter-spacing="2">EVENT ZEKA</text>
    </g>
    <g transform="translate(72 936)">
      <rect width="330" height="66" rx="33" fill="url(#pill)"/>
      <text x="28" y="44" fill="#090A14" font-family="DejaVu Sans, Arial, sans-serif" font-size="27" font-weight="700" letter-spacing="1">${escapeXml(formatDateLabel(input.date, input.time))}</text>
    </g>
    ${titleText}
    <text x="73" y="1244" fill="#D8D9E2" font-family="DejaVu Sans, Arial, sans-serif" font-size="34" font-weight="600">${escapeXml(venue.length > 42 ? `${venue.slice(0, 41)}…` : venue)}</text>
    <text x="73" y="1301" fill="#A6A2FF" font-family="DejaVu Sans, Arial, sans-serif" font-size="31" font-weight="700">@${escapeXml(handle)}</text>
  </svg>`);
}

async function buildPosterBackground(poster?: Buffer | null): Promise<Buffer> {
  if (!poster) {
    return sharp({
      create: {
        width: SLIDE_WIDTH,
        height: SLIDE_HEIGHT,
        channels: 4,
        background: { r: 5, g: 6, b: 9, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
  }

  try {
    return await sharp(poster)
      .rotate()
      .resize(SLIDE_WIDTH, SLIDE_HEIGHT, { fit: "cover" })
      .blur(24)
      .modulate({ brightness: 0.45, saturation: 0.72 })
      .png()
      .toBuffer();
  } catch {
    return buildPosterBackground(null);
  }
}

async function buildContainedPoster(poster?: Buffer | null): Promise<Buffer | null> {
  if (!poster) {
    return null;
  }
  try {
    return await sharp(poster)
      .rotate()
      .resize(920, 840, {
        fit: "contain",
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toBuffer();
  } catch {
    return null;
  }
}

export async function renderEventCarouselSlide(input: EventCarouselSlideInput): Promise<Buffer> {
  const [background, containedPoster] = await Promise.all([
    buildPosterBackground(input.poster),
    buildContainedPoster(input.poster),
  ]);
  const composites: sharp.OverlayOptions[] = [];
  if (containedPoster) {
    composites.push({ input: containedPoster, left: 80, top: 100 });
  }
  composites.push({ input: eventOverlaySvg(input), left: 0, top: 0 });

  return sharp(background).composite(composites).png({ compressionLevel: 9 }).toBuffer();
}

export async function renderCtaCarouselSlide(): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1350">
    <defs>
      <radialGradient id="bg" cx="72%" cy="72%" r="82%">
        <stop offset="0" stop-color="#25204D"/>
        <stop offset="0.48" stop-color="#0B0D16"/>
        <stop offset="1" stop-color="#050609"/>
      </radialGradient>
      <linearGradient id="fur" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#B4B1FF"/>
        <stop offset="1" stop-color="#7C76F2"/>
      </linearGradient>
    </defs>
    <rect width="1080" height="1350" fill="url(#bg)"/>
    <circle cx="790" cy="1040" r="330" fill="none" stroke="#8B86FB" stroke-width="3" opacity="0.16"/>
    <text x="72" y="130" fill="#A6A2FF" font-family="DejaVu Sans, Arial, sans-serif" font-size="32" font-weight="700" letter-spacing="4">EVENT ZEKA • BEOGRAD</text>
    <text x="66" y="344" fill="#F7F8F8" font-family="DejaVu Sans, Arial, sans-serif" font-size="112" font-weight="700" letter-spacing="-5">JOŠ</text>
    <text x="66" y="463" fill="#F7F8F8" font-family="DejaVu Sans, Arial, sans-serif" font-size="112" font-weight="700" letter-spacing="-5">DOGAĐAJA?</text>
    <rect x="70" y="535" width="620" height="118" rx="30" fill="url(#fur)"/>
    <text x="106" y="616" fill="#080A17" font-family="DejaVu Sans, Arial, sans-serif" font-size="64" font-weight="700" letter-spacing="-2">ZEKA ZNA.</text>
    <text x="72" y="754" fill="#F7F8F8" font-family="DejaVu Sans, Arial, sans-serif" font-size="38" font-weight="700">Svi događaji. Svi detalji.</text>
    <text x="72" y="810" fill="#C6C8D2" font-family="DejaVu Sans, Arial, sans-serif" font-size="31">Na jednom mestu, svakog dana.</text>
    <rect x="70" y="885" width="780" height="116" rx="58" fill="#F7F8F8"/>
    <text x="108" y="955" fill="#080A17" font-family="DejaVu Sans, Arial, sans-serif" font-size="30" font-weight="700">events.ineedtofeedmyrabbit.com</text>
    <text x="75" y="1092" fill="#A6A2FF" font-family="DejaVu Sans, Arial, sans-serif" font-size="27" font-weight="700" letter-spacing="2">ZAPRATI @EVENTZEKA</text>
    <g>
      <ellipse cx="810" cy="1030" rx="70" ry="176" transform="rotate(-13 810 1030)" fill="url(#fur)"/>
      <ellipse cx="960" cy="1030" rx="70" ry="176" transform="rotate(13 960 1030)" fill="url(#fur)"/>
      <ellipse cx="820" cy="1030" rx="28" ry="118" transform="rotate(-13 820 1030)" fill="#5C56C8" opacity="0.64"/>
      <ellipse cx="950" cy="1030" rx="28" ry="118" transform="rotate(13 950 1030)" fill="#5C56C8" opacity="0.64"/>
      <circle cx="885" cy="1270" r="230" fill="url(#fur)"/>
      <circle cx="810" cy="1232" r="25" fill="#080A17"/>
      <circle cx="960" cy="1232" r="25" fill="#080A17"/>
      <path d="M860 1291c13-11 37-11 50 0-6 16-17 24-25 24s-19-8-25-24Z" fill="#080A17"/>
    </g>
    <path d="m941 700 14 32 32 14-32 14-14 32-14-32-32-14 32-14 14-32Z" fill="#F7F8F8"/>
  </svg>`;

  return sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
}
